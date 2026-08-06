/**
 * scripts/sweep/should-sweep.ts — READ-ONLY wake probe for the scheduled sweep
 * timer.
 *
 * A FLSclaw scheduled task runs this as its pre-task `script`
 * (container/agent-runner/src/scheduling/task-script.ts): bash, 30s hard
 * timeout, and the LAST stdout line must be `{"wakeAgent": <bool>, "data": …}`.
 * `wakeAgent: false`, a non-zero exit, or garbage output all mean "task
 * skipped, agent not woken" — so the failure directions are asymmetric: waking
 * wrongly burns a whole agent session, staying silent wrongly only costs one
 * timer tick. Every uncertain arm below therefore resolves toward NOT waking.
 *
 * Invocation (the scheduled task's script body):
 *
 *   cd <clone> && pnpm exec tsx scripts/sweep/should-sweep.ts \
 *     [--repo <clone>] [--workspace <group-root>] [--inventory <dir>] [--upstream <remote/branch>]
 *
 * THIS COMMAND MUTATES NOTHING. It is the question "would `sweep start` have
 * anything to do?", answered without running any of `start`'s machinery —
 * which is unusable here on both counts: `cmdSweepStart` fetches remotes,
 * clean-slates the prior pass dir, deletes merged origin refs, creates
 * recovery PRs and lands approved merges (all mutations), and routinely runs
 * for minutes (over the 30s budget). The probe reads the SAME sources of truth
 * directly instead:
 *   - the pass dir (local disk) for an in-flight pass,
 *   - `git ls-remote` for the live origin/upstream tips — a pure network read
 *     that updates NO local refs (a fetch would),
 *   - the GitHub API (GETs only) for the state of the `fix/sweep/*` gate PRs,
 *     mirroring `deriveOriginMergeStatus`'s decision table without its writes.
 *
 * TIME BUDGET (30s hard, killed by the runner). Measured 2026-08-06 on the dev
 * clone: tsx start+imports ~1s, `ls-remote --heads origin` ~1.0s, `ls-remote
 * upstream` ~1.2s, `loadRegistry` ~0.1s, `resolveScope(includeRemote)` ~5.7s,
 * one GitHub GET ~0.3-0.5s (a gated ref costs up to 3+pagination). Spending
 * plan: the two ls-remotes always run (they are the cheapest authoritative
 * facts); the per-ref API loop and the scope resolution are the elective
 * spends, cut off at SOFT_BUDGET_MS with a conservative fallback (unclassified
 * refs count as gated; an unresolved scope skips the upstream-advance wake).
 * A network hang is not defended in-process: the runner's own 30s kill maps to
 * "skipped", which is already the safe direction.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve as pathResolve } from 'node:path';

import { git } from './git.js';
import { loadRegistry } from './registry.js';
import { resolveScope } from './scope.js';
import { slug } from './steps.js';
import {
  classifyComments,
  classifyReviewTrigger,
  getPrsByHead,
  listIssueComments,
  listReviews,
  maxRealReviewId,
  parseGithubSlug,
  realGithubTransport,
  type GithubTransport,
  type PrByHead,
  type PrComment,
  type PrReview,
} from './publish.js';
import { parseCli, passDir, readJournal, type Cli } from './propagate.js';
import type { MergeModel } from './types.js';

/**
 * Elective-work cutoff. 20s leaves ≥10s of the runner's 30s for startup, the
 * two ls-remotes and JSON emission even when every measured number doubles.
 */
const SOFT_BUDGET_MS = 20_000;

// --------------------------------------------------------------------------
// Contract output.
// --------------------------------------------------------------------------

export interface ProbeDecision {
  wakeAgent: boolean;
  /** Rendered into the woken agent's prompt (content.scriptOutput) — it must say WHY. */
  data?: { reason: string; signals: string[] };
}

/** The task-script contract line: one-line JSON, `wakeAgent` a real boolean. */
export function renderContractLine(decision: ProbeDecision): string {
  return JSON.stringify({ wakeAgent: decision.wakeAgent === true, ...(decision.data ? { data: decision.data } : {}) });
}

function note(msg: string): void {
  process.stderr.write(`should-sweep: ${msg}\n`);
}

// --------------------------------------------------------------------------
// Pure pieces (unit-tested; no I/O).
// --------------------------------------------------------------------------

export interface FixSweepRef {
  /** Branch name of the ref, e.g. fix/sweep/main_patched--gate-fix-… */
  ref: string;
  sha: string;
  /** The scope branch the ref gates, or null when no candidate matches. */
  branch: string | null;
}

/**
 * Split origin's branch heads into the fix/sweep gate refs (target branch
 * recovered by slug prefix) and everything else. Longest slug first — slug()
 * is lossy and branch names may themselves contain `--`, so a shorter branch's
 * slug can be a prefix of a longer one's (same reason deriveOriginMergeStatus
 * sorts its candidates). The prefix test is anchored at `fix/sweep/`: a branch
 * merely CONTAINING that string (live example `feat/fix/sweep-d062`, origin
 * 2026-08-06) is not a gate ref.
 */
export function fixSweepRefs(originHeads: Map<string, string>): FixSweepRef[] {
  const candidates = [...originHeads.keys()]
    .filter((b) => !b.startsWith('fix/sweep/'))
    .map((b) => ({ branch: b, slug: slug(b) }))
    .sort((a, b) => b.slug.length - a.slug.length);
  const out: FixSweepRef[] = [];
  for (const [name, sha] of originHeads) {
    if (!name.startsWith('fix/sweep/')) continue;
    const rest = name.slice('fix/sweep/'.length);
    const target = candidates.find((c) => rest.startsWith(`${c.slug}--`))?.branch ?? null;
    out.push({ ref: name, sha, branch: target });
  }
  return out;
}

/**
 * What a fix/sweep ref means for the NEXT `sweep start`, derived from its PR
 * state exactly as `deriveOriginMergeStatus` derives it — minus the writes that
 * follow. Only `gated` keeps the branch blocked; every other disposition is
 * work `start` would actually do, i.e. a reason to wake.
 */
export type RefDisposition =
  | { kind: 'gated' }
  /** PR merged (incl. squash/rebase) — the owner's decision landed; start unblocks + cleans up. */
  | { kind: 'gate-cleared'; prNumber: number }
  /** PR closed unmerged — the owner withdrew the case; start ungates the branch. */
  | { kind: 'case-withdrawn'; prNumber: number }
  /** No PR at all — a crashed publish; start creates the recovery PR. */
  | { kind: 'publish-crashed' }
  /** A review beyond the sweep-addressed marker — start lands (APPROVED) or reissues. */
  | { kind: 'review-due'; prNumber: number; reviewState: string };

export function classifyPrs(prs: PrByHead[]): {
  open: PrByHead | null;
  merged: PrByHead | null;
  closed: PrByHead | null;
} {
  return {
    open: prs.find((p) => p.state === 'open') ?? null,
    merged: prs.find((p) => p.mergedAt !== null) ?? null,
    closed: prs.length > 0 ? prs[0] : null,
  };
}

/**
 * The open-PR arm: reviews are the only trigger (D-059). The marker is bounded
 * by the max real review id so a pasted marker cannot silence the loop, and a
 * DISMISSED-only tail does not wake (start would merely advance the marker and
 * stay blocked — bookkeeping, not a session's worth of work).
 */
export function openPrReviewDisposition(prNumber: number, reviews: PrReview[], comments: PrComment[]): RefDisposition {
  const { markerId } = classifyComments(comments, maxRealReviewId(reviews));
  const trigger = classifyReviewTrigger(reviews, markerId);
  if (!trigger.reissueDue) return { kind: 'gated' };
  return { kind: 'review-due', prNumber, reviewState: trigger.latest!.state };
}

export interface ScopeLiteEntry {
  branch: string;
  mergeModel: MergeModel;
  /** Merge sources for mergeModel 'parents' (roots default to main_patched). */
  parents: string[];
}

/**
 * Which branches would actually RECEIVE new upstream content, given the gated
 * set: upstream-chain branches take it directly, parents-model branches only
 * through an ungated parent that itself receives. This is the negative case
 * the probe exists to get right: with every entry path gated, a fresh pass can
 * only re-derive the same blocked picture and stop — waking for that burns a
 * session to produce nothing (the 30s/one-session asymmetry in the header).
 * `main` is deliberately NOT an entry here: its fast-forward alone is not
 * worth a session — it rides along whenever any real propagation happens.
 */
export function branchesReceivingUpstream(ordered: ScopeLiteEntry[], gated: Set<string>): string[] {
  const receives = new Set<string>();
  for (const e of ordered) {
    if (gated.has(e.branch)) continue;
    if (e.mergeModel === 'upstream-chain') receives.add(e.branch);
    else if (e.parents.some((p) => receives.has(p))) receives.add(e.branch);
  }
  return [...receives];
}

// --------------------------------------------------------------------------
// Collector (I/O behind an injectable seam).
// --------------------------------------------------------------------------

export interface ProbeDeps {
  /** `git ls-remote --heads <remote>` — branch name (no refs/heads/) → sha. */
  lsRemoteHeads(repo: string, remote: string): Promise<Map<string, string>>;
  originSlug(repo: string): Promise<{ owner: string; repo: string } | null>;
  makeTransport(token: string): GithubTransport;
  resolveScopeLite(cli: Cli): Promise<ScopeLiteEntry[]>;
  env: Record<string, string | undefined>;
  now(): number;
}

export const defaultProbeDeps: ProbeDeps = {
  async lsRemoteHeads(repo, remote) {
    const res = await git(repo, ['ls-remote', '--heads', remote]);
    const out = new Map<string, string>();
    for (const line of res.stdout.split('\n')) {
      const m = /^([0-9a-f]{40})\s+refs\/heads\/(.+)$/.exec(line.trim());
      if (m) out.set(m[2], m[1]);
    }
    return out;
  },
  async originSlug(repo) {
    const url = (await git(repo, ['remote', 'get-url', 'origin'], { allowCodes: [1, 2, 128] })).stdout.trim();
    return url ? parseGithubSlug(url) : null;
  },
  makeTransport: realGithubTransport,
  async resolveScopeLite(cli) {
    const registry = loadRegistry({
      inventoryDir: cli.inventory,
      scopeFile: cli.scopeFile,
      routingFile: cli.routingFile,
    });
    const scope = await resolveScope(cli.repo, registry.features, registry.scope, { includeRemote: true });
    return scope.ordered.map((e) => ({ branch: e.branch, mergeModel: e.mergeModel, parents: e.parents }));
  },
  env: process.env,
  now: Date.now,
};

/**
 * An in-flight pass, by `attachPass`'s own definition of "open" (a
 * plan-initial.json with no `pass-complete` journal row — the machine-state
 * phase alone is NOT authoritative, see cmdSweepAbort C-4). Ties broken like
 * attachPass: the pass with the newest plan-initial.json wins.
 */
export function openPassInfo(
  workspace: string,
): { dir: string; phase: string | null; currentCase: string | null } | null {
  const root = join(workspace, 'propagation');
  if (!existsSync(root)) return null;
  const open = readdirSync(root)
    .filter((d) => d.startsWith('pass-'))
    .map((d) => join(root, d))
    .filter(
      (d) => existsSync(join(d, 'plan-initial.json')) && !readJournal(d).some((e) => e.action === 'pass-complete'),
    );
  if (open.length === 0) return null;
  open.sort((a, b) => statSync(join(a, 'plan-initial.json')).mtimeMs - statSync(join(b, 'plan-initial.json')).mtimeMs);
  const dir = open[open.length - 1];
  let phase: string | null = null;
  let currentCase: string | null = null;
  try {
    const st = JSON.parse(readFileSync(join(dir, 'machine-state.json'), 'utf8')) as {
      phase?: string;
      currentCase?: { caseId?: string } | null;
    };
    phase = typeof st.phase === 'string' ? st.phase : null;
    currentCase = st.currentCase?.caseId ?? null;
  } catch {
    /* no/unreadable machine state — still an open pass */
  }
  return { dir, phase, currentCase };
}

export async function probeShouldSweep(cli: Cli, deps: ProbeDeps): Promise<ProbeDecision> {
  const started = deps.now();
  const budgetLeft = (): boolean => deps.now() - started < SOFT_BUDGET_MS;

  // 1. In-flight pass — the cheapest and most decisive signal (local disk, no
  // network): an open pass means resume/abort work exists RIGHT NOW, and
  // `start` would refuse (ERR30) until it is dealt with.
  const inflight = openPassInfo(cli.workspace);
  if (inflight) {
    const where = inflight.phase
      ? ` (phase ${inflight.phase}${inflight.currentCase ? `, case ${inflight.currentCase}` : ''})`
      : '';
    return {
      wakeAgent: true,
      data: {
        reason: `an in-flight sweep pass is open at ${inflight.dir}${where} — resume it (finish or abort) before anything else`,
        signals: [`in-flight pass: ${inflight.dir}${where}`],
      },
    };
  }

  // 2. Live remote tips — ls-remote, never fetch (fetch writes remote-tracking
  // refs; the probe's whole contract is that it writes nothing).
  const originHeads = await deps.lsRemoteHeads(cli.repo, 'origin');
  const [upRemote, ...upRest] = cli.upstream.split('/');
  let upstreamTip: string | null = null;
  if (upRest.length > 0) {
    try {
      upstreamTip = (await deps.lsRemoteHeads(cli.repo, upRemote)).get(upRest.join('/')) ?? null;
      if (!upstreamTip)
        note(`upstream branch '${upRest.join('/')}' not found on remote '${upRemote}' — upstream signal skipped`);
    } catch (e) {
      note(`ls-remote ${upRemote} failed (${e instanceof Error ? e.message : String(e)}) — upstream signal skipped`);
    }
  } else {
    note(`--upstream '${cli.upstream}' is not <remote>/<branch> — upstream signal skipped`);
  }

  // 3. Gate refs. Fail-closed like the driver: anything we cannot classify
  // (no token, no slug, API error, budget out) counts as GATED — an unknown
  // must never read as "cleared" and wake for nothing.
  const refs = fixSweepRefs(originHeads).filter((r) => {
    if (r.branch === null)
      note(`origin ref '${r.ref}' matches no origin branch — ignored (driver treats it as non-blocking)`);
    return r.branch !== null;
  });
  const signals: string[] = [];
  const gated = new Set<string>();
  if (refs.length > 0) {
    const token = deps.env.GH_TOKEN?.trim() || deps.env.GITHUB_TOKEN?.trim() || null;
    const slugParts = token ? await deps.originSlug(cli.repo) : null;
    if (!token || !slugParts) {
      note(
        token
          ? 'cannot derive owner/repo from origin — all gate refs count as gated'
          : 'no GH_TOKEN/GITHUB_TOKEN in env — all gate refs count as gated',
      );
      for (const r of refs) gated.add(r.branch!);
    } else {
      const transport = deps.makeTransport(token);
      for (const r of refs) {
        if (!budgetLeft()) {
          note(`soft budget spent — ${r.ref} and later refs count as gated`);
          gated.add(r.branch!);
          continue;
        }
        try {
          const prs = await getPrsByHead(transport, slugParts, r.ref);
          const { open, merged, closed } = classifyPrs(prs);
          let d: RefDisposition;
          if (open) {
            d = openPrReviewDisposition(
              open.number,
              await listReviews(transport, slugParts, open.number),
              await listIssueComments(transport, slugParts, open.number),
            );
          } else if (merged) d = { kind: 'gate-cleared', prNumber: merged.number };
          else if (closed) d = { kind: 'case-withdrawn', prNumber: closed.number };
          else d = { kind: 'publish-crashed' };

          switch (d.kind) {
            case 'gated':
              gated.add(r.branch!);
              break;
            case 'gate-cleared':
              signals.push(`gate cleared: PR #${d.prNumber} on ${r.ref} was merged — ${r.branch} is unblocked`);
              break;
            case 'case-withdrawn':
              signals.push(
                `case withdrawn: PR #${d.prNumber} on ${r.ref} was closed by the owner — ${r.branch} is no longer gated`,
              );
              break;
            case 'publish-crashed':
              signals.push(`crashed publish: ${r.ref} has no PR — start would recover it into a PR`);
              break;
            case 'review-due':
              gated.add(r.branch!); // reissue keeps the branch blocked; APPROVED unblocks, but the wake signal covers it either way
              signals.push(
                `review pending: PR #${d.prNumber} on ${r.ref} has a new ${d.reviewState} review to address`,
              );
              break;
          }
        } catch (e) {
          note(`PR lookup for ${r.ref} failed (${e instanceof Error ? e.message : String(e)}) — counts as gated`);
          gated.add(r.branch!);
        }
      }
    }
  }

  // 4. Upstream advance — only worth the scope resolution when nothing else
  // already decided the wake and the tip is genuinely unswept. "Swept" is a
  // `pass-complete` row at the tip's pass dir; an ABORTED pass also wrote one,
  // deliberately: abort is the agent standing down at this watermark, and
  // re-waking on the same tip would loop abort → wake → abort until the next
  // upstream commit.
  if (upstreamTip) {
    const swept = readJournal(passDir(cli.workspace, upstreamTip.slice(0, 12))).some(
      (e) => e.action === 'pass-complete',
    );
    if (!swept && signals.length === 0) {
      if (!budgetLeft()) {
        note('soft budget spent before scope resolution — upstream-advance wake skipped this tick');
      } else {
        try {
          const receiving = branchesReceivingUpstream(await deps.resolveScopeLite(cli), gated);
          if (receiving.length > 0) {
            const shown =
              receiving.slice(0, 6).join(', ') + (receiving.length > 6 ? `, +${receiving.length - 6} more` : '');
            signals.push(
              `upstream advanced: ${cli.upstream} tip ${upstreamTip.slice(0, 12)} has no completed pass — would reach ${shown}`,
            );
          } else {
            note(
              `upstream tip ${upstreamTip.slice(0, 12)} is unswept but EVERY entry path is gated (${[...gated].join(', ')}) — a pass could only stop again; not waking`,
            );
          }
        } catch (e) {
          note(
            `scope resolution failed (${e instanceof Error ? e.message : String(e)}) — upstream-advance wake skipped this tick`,
          );
        }
      }
    } else if (!swept) {
      signals.push(`upstream advanced: ${cli.upstream} tip ${upstreamTip.slice(0, 12)} has no completed pass`);
    }
  }

  if (signals.length === 0) return { wakeAgent: false };
  return {
    wakeAgent: true,
    data: {
      reason:
        signals.length === 1
          ? signals[0]
          : `${signals.length} sweep signals: ${signals[0]} (and ${signals.length - 1} more — see signals)`,
      signals,
    },
  };
}

// --------------------------------------------------------------------------
// CLI.
// --------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && /should-sweep\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  const cli = parseCli(['should-sweep', ...process.argv.slice(2)]);
  // Mirror cmdSweepStart's inventory default (the group-root sibling) so the
  // probe's scope is the same one the sweep it wakes will run with.
  if (cli.inventory === undefined) {
    const defaultInv = pathResolve(cli.repo, '..', 'inventory');
    if (existsSync(defaultInv)) cli.inventory = defaultInv;
  }
  probeShouldSweep(cli, defaultProbeDeps).then(
    (decision) => {
      process.stdout.write(renderContractLine(decision) + '\n');
      process.exit(0);
    },
    (err) => {
      // NO catch-all "wakeAgent: false" here: the runner already maps a
      // non-zero exit to "skip", and an explicit false would make a broken
      // probe indistinguishable from a considered no in the task log.
      console.error(err instanceof Error ? err.stack || err.message : String(err));
      process.exit(1);
    },
  );
}

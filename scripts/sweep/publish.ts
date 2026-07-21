/**
 * scripts/sweep/publish.ts — mechanics for `propagate publish --case <id>`,
 * the ONLY sanctioned PR-creation path (PROPAGATION.md §14, D-048).
 *
 * Born from the 2026-07-21 forensic reviews of the freeze PRs:
 *  - the D-030 head shape (PR head on the parent's line) made GitHub show the
 *    whole pending range — 26-60x diff bloat — and pushing those heads
 *    back-doored unpushed protected-branch merge commits onto origin. The
 *    replacement is the EXHIBIT HEAD (buildExhibit): a synthetic commit
 *    parented on the ORIGIN base tip whose tree is the base tree with ONLY the
 *    case's conflicted paths overlaid, hard-asserted to diff to exactly the
 *    conflict set (ERR03) with no local-only ancestry (ERR04).
 *  - the driver's template PR prose could never pass its own text gate (a
 *    3-round rewrite loop); the driver now NEVER generates prose — the agent
 *    writes pr/title.txt + pr/body.md itself and prTextGate mediates a
 *    context-free cold read with a HARD two-round cap.
 *  - no gate asked "should this PR exist": decidedAlready (ERR05) matches the
 *    conflict against decisions recorded in inventory `prompt.extra_context` /
 *    `decided_paths`; duplicate-signature detection (ERR06) lives in the CLI.
 *
 * Every check returns a machine-readable Issue {id, detail}; ERR* ids block,
 * WARN* ids are advisory. HALT_IDS maps the existing DriverHalt reasons onto
 * the same scheme for run/resolve CLI output. The registry of ids is
 * PROPAGATION.md §14 (single source of truth).
 *
 * Network: the GitHub REST API is called directly from node (`gh` and
 * `python3` do not exist in the agent container; `git push` to github fails
 * through the credential proxy). Requests go to api.github.com with
 * `Authorization: Bearer <substitute token>` — the proxy swaps the header on
 * the wire — honouring HTTPS_PROXY via a CONNECT tunnel. The transport is
 * injectable (GithubTransport) so tests never touch the network, and a
 * dry-run publish never constructs one at all.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';
import { promisify } from 'node:util';

import { git, refExists, revParse } from './git.js';
import type { FeatureEntry, PrTextVerdict } from './types.js';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Result ids (§14, D-048). ERR* blocks, WARN* is advisory. The full registry
// with meanings + prescribed agent actions lives in PROPAGATION.md §14 and the
// doctrine's "Tool result IDs" table.
// ---------------------------------------------------------------------------

export interface Issue {
  id: string;
  detail: string;
}

/** Any ERR* id blocks a publish; WARN* ids are returned but never block. */
export function isBlocking(id: string): boolean {
  return id.startsWith('ERR');
}

/**
 * Existing DriverHalt reasons surfaced under the same id scheme in CLI output
 * (§14). The human text stays in `detail`; the journal keeps the raw reason.
 */
export const HALT_IDS: Record<string, string> = {
  'sync-diverged': 'ERR20_BRANCH_DIVERGED',
  'merge-failed': 'ERR21_MERGE_FAILED',
  'dirty-worktree': 'ERR22_DIRTY_WORKTREE',
  'protected-ref': 'ERR23_PROTECTED_REF',
  'plan-drift': 'ERR24_PLAN_DRIFT',
  'bad-case-id': 'ERR25_BAD_CASE_ID',
};

export function haltIdFor(reason: string): string | null {
  return HALT_IDS[reason] ?? null;
}

// ---------------------------------------------------------------------------
// Exhibit head (§14; supersedes the D-030 "parent's conflicting head" shape).
// ---------------------------------------------------------------------------

export interface Exhibit {
  /** The commit the exhibit is parented on: origin/<branch> tip, or the local tip fallback. */
  parent: string;
  parentSource: 'origin' | 'local';
  /** Tree = base tree with ONLY the conflicted paths overlaid from `sourceTree`. */
  tree: string;
  commit: string;
}

/** `git ls-tree` entry for one path inside a tree, or null when absent. */
async function lsTreeEntry(
  repo: string,
  tree: string,
  path: string,
): Promise<{ mode: string; oid: string } | null> {
  const res = await git(repo, ['ls-tree', tree, '--', path]);
  const line = res.stdout.split('\n').find(Boolean);
  if (!line) return null;
  const m = /^(\d{6}) blob ([0-9a-f]{40})\t/.exec(line);
  return m ? { mode: m[1], oid: m[2] } : null;
}

/**
 * Base tree with ONLY `paths` overlaid from `sourceTree` (checkout-free, via a
 * temporary index): a path present in the source tree replaces the base entry;
 * a path absent there (delete/modify conflict resolved by deletion) is removed.
 * This is the sibling of createCaseWorktree's commit-tree technique, restricted
 * to the conflict set so the resulting diff can be hard-asserted (ERR03).
 */
export async function overlayTree(repo: string, baseTree: string, sourceTree: string, paths: string[]): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'sweep-exhibit-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  try {
    await git(repo, ['read-tree', baseTree], { env });
    for (const path of paths) {
      const entry = await lsTreeEntry(repo, sourceTree, path);
      if (entry) {
        await git(repo, ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`], { env });
      } else {
        await git(repo, ['update-index', '--force-remove', '--', path], { env });
      }
    }
    return (await git(repo, ['write-tree'], { env })).stdout.trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Construct the exhibit head for a case (§14): parent = the ORIGIN base-branch
 * tip (falling back to the local tip only when no origin ref exists), tree =
 * that base tree with only `conflictedPaths` overlaid from `sourceTree`
 * (HELD: the recomputed automerge tree — the conflict markers ARE the exhibit;
 * JUDGED: the resolved merge commit's tree). Origin-parenting structurally
 * keeps local-only protected-branch commits out of the pushed ancestry (the
 * PR-#58 back-door); checkExhibitAncestry asserts it anyway (ERR04).
 */
export async function buildExhibit(
  repo: string,
  branch: string,
  sourceTree: string,
  conflictedPaths: string[],
  caseId: string,
): Promise<Exhibit> {
  const originRef = `origin/${branch}`;
  const parentSource: Exhibit['parentSource'] = (await refExists(repo, originRef)) ? 'origin' : 'local';
  const parent = await revParse(repo, parentSource === 'origin' ? originRef : branch);
  const baseTree = (await git(repo, ['rev-parse', `${parent}^{tree}`])).stdout.trim();
  const tree = await overlayTree(repo, baseTree, sourceTree, conflictedPaths);
  const commit = (
    await git(repo, ['commit-tree', tree, '-p', parent, '-m', `exhibit head for ${caseId} (D-048, PROPAGATION.md §14)`])
  ).stdout.trim();
  return { parent, parentSource, tree, commit };
}

/**
 * ERR03 hard assert on the exhibit diff (`git diff --name-only <parent> <exhibit>`):
 * - HELD: must equal the conflicted paths EXACTLY — markers exist for every
 *   conflicted path by construction, so any deviation is a defect.
 * - JUDGED: must be a NON-EMPTY SUBSET — a resolution may legitimately keep the
 *   origin-base side of a path byte-identical (that path then has nothing to
 *   exhibit and drops out of the diff), but extra paths still mean smuggled
 *   content, and an empty diff is a no-op PR (the #40 disease), both blocked.
 */
export async function checkExhibitDiff(
  repo: string,
  exhibit: Exhibit,
  conflictedPaths: string[],
  tier: 'held' | 'judged' = 'held',
): Promise<Issue | null> {
  const res = await git(repo, ['diff', '--name-only', exhibit.parent, exhibit.commit]);
  const actual = res.stdout.split('\n').filter(Boolean).sort();
  const expected = [...conflictedPaths].sort();
  const expectedSet = new Set(expected);
  const ok =
    tier === 'held'
      ? JSON.stringify(actual) === JSON.stringify(expected)
      : actual.length > 0 && actual.every((p) => expectedSet.has(p));
  if (ok) return null;
  return {
    id: 'ERR03_DIFF_EXCEEDS_CONFLICT_SET',
    detail:
      `exhibit diff [${actual.join(', ')}] vs conflicted paths [${expected.join(', ')}] — ` +
      (tier === 'held'
        ? `a held exhibit must show the conflict set exactly`
        : `a judged exhibit must be a non-empty subset of the conflict set`) +
      ` (PROPAGATION.md §14)`,
  };
}

/**
 * ERR04 assert: the exhibit's pushed ancestry must add NOTHING beyond the
 * origin tip — structurally guaranteed by origin-parenting, asserted anyway.
 * With an origin ref, the parent must BE the origin tip and the only commit
 * above it must be the exhibit itself. Without one, the local-tip fallback is
 * sanctioned and there is no origin baseline to compare against.
 */
export async function checkExhibitAncestry(repo: string, exhibit: Exhibit, branch: string): Promise<Issue | null> {
  const originRef = `origin/${branch}`;
  if (!(await refExists(repo, originRef))) return null;
  const originTip = await revParse(repo, originRef);
  if (exhibit.parent !== originTip) {
    return {
      id: 'ERR04_UNPUSHED_PARENT',
      detail: `exhibit parent ${exhibit.parent.slice(0, 12)} is not the origin tip ${originTip.slice(0, 12)} — pushing it would carry local-only commits`,
    };
  }
  const extra = (await git(repo, ['rev-list', exhibit.commit, `^${originTip}`])).stdout.split('\n').filter(Boolean);
  if (extra.length !== 1 || extra[0] !== exhibit.commit) {
    return {
      id: 'ERR04_UNPUSHED_PARENT',
      detail: `exhibit ancestry carries ${extra.length - 1} local-only commit(s) beyond origin — refusing to publish`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ERR05 — "should this PR exist": recorded-decision match (§14).
// ---------------------------------------------------------------------------

/** The line(s) of `text` mentioning `needle`, capped — quoted in the ERR05 detail. */
function excerptAround(text: string, needle: string, cap = 400): string {
  const lines = text.split('\n').filter((l) => l.includes(needle));
  const joined = (lines.length ? lines : [text]).join(' / ').trim();
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined;
}

/**
 * ERR05_DECIDED_ALREADY: a conflicted path hits a decision already recorded in
 * the inventory — an explicit `prompt.decided_paths` entry, or a path
 * mentioned verbatim in `prompt.extra_context` (D-030 write-back records).
 * Three of the six 2026-07-21 freeze PRs re-raised recorded decisions; the
 * prescribed action is to APPLY the quoted record as a judged resolution, not
 * to re-ask the owner.
 */
export function decidedAlready(features: FeatureEntry[], branch: string, conflictedPaths: string[]): Issue | null {
  for (const f of features) {
    const decided = f.prompt?.decided_paths ?? [];
    const ctx = f.prompt?.extra_context ?? '';
    const hit =
      conflictedPaths.find((p) => decided.includes(p)) ?? (ctx ? conflictedPaths.find((p) => ctx.includes(p)) : undefined);
    if (!hit) continue;
    const record = ctx ? excerptAround(ctx, hit) : `decided_paths: ${decided.join(', ')}`;
    return {
      id: 'ERR05_DECIDED_ALREADY',
      detail:
        `'${hit}' (case branch ${branch}) is covered by a decision recorded in inventory entry '${f.id}'` +
        `${f.branch ? ` (branch ${f.branch})` : ''}: "${record}" — apply the recorded decision as a judged resolution; do not re-ask the owner`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PR-text cold read (§14, D-048) — driver-mediated, HARD two-round cap.
// ---------------------------------------------------------------------------

/** Freshness binding for prtext verdicts: sha256 over `<title>\n<body>`. */
export function prTextHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`, 'utf8').digest('hex');
}

/**
 * Tautology phrases of the retired driver-generated PR bodies (the templates
 * that looped the 2026-07-21 text gate for 3 rounds) — their presence in an
 * agent-written body is WARN01_TEMPLATE_TEXT.
 */
export const TAUTOLOGY_PHRASES = [
  'behavior kept:',
  'behavior lost if merged blindly',
  'The driver could not mechanically resolve this',
  'Cold-read confirmed the resolution',
  'The unmergeable state IS the conflict exhibit',
];

export interface PrTextGateInput {
  /** The case's pr/ directory (title.txt, body.md, prtext-* artifacts). */
  prDir: string;
  caseId: string;
  title: string;
  body: string;
  conflictedPaths: string[];
  /** Driver-written pr/materials.md content ('' when absent). */
  materials: string;
  /** Relevant inventory extra_context excerpts (the derivability inputs for Q0). */
  inventoryContext: string;
}

export interface PrTextGateResult {
  /** Blocking issue (ERR09/ERR10, or ERR05/ERR06 semantics from a verdict), or null = text approved. */
  issue: Issue | null;
  /** Advisory issues (WARN04 when round-2 caveats ship). */
  warnings: Issue[];
  /** Round-2 reader notes to append to the body under '## Caveats (cold reader)'. */
  caveats: string[];
}

const REQUEST_FILE = 'prtext-review-request.md';
const VERDICT_FILE = 'prtext-verdict.json';

/** Adequacy-first question list for the review request (§14). */
const PRTEXT_QUESTIONS = [
  'Q0 (adequacy first). Does this PR need to exist? If the decision is already recorded, derivable from the code',
  'or the case rules, or this is a duplicate of a sibling case: answer verdict `reject-derivable` (or `consolidate`',
  'for a duplicate) and put the derived answer in `derivedAnswer` — do not review the prose of a PR that should not exist.',
  'Q1. From the text alone, state the ONE-LINE decision being asked and what changes if the owner answers yes vs no.',
  'If that is impossible from the text, answer verdict `rewrite` with concrete notes — there is exactly ONE rewrite.',
  'Otherwise answer verdict `publish` (notes optional; round-2 notes ship as Caveats on the PR).',
];

function writePrTextRequest(input: PrTextGateInput, round: number, hash: string): void {
  mkdirSync(input.prDir, { recursive: true });
  const lines = [
    `# PR-text cold read — ${input.caseId}`,
    '',
    `round: ${round}`,
    `textHash: ${hash}`,
    '',
    'You are the repository owner opening this pull request COLD — no sweep context, no session history.',
    'Everything you may use is in this file.',
    '',
    '## Title',
    '',
    input.title,
    '',
    '## Body',
    '',
    input.body,
    '',
    '## Conflicted paths',
    '',
    ...input.conflictedPaths.map((p) => `- ${p}`),
    '',
    '## Case materials (driver facts)',
    '',
    input.materials || '(none)',
    '',
    '## Inventory context (derivability inputs)',
    '',
    input.inventoryContext || '(none)',
    '',
    '## Questions (answer in order)',
    '',
    ...PRTEXT_QUESTIONS,
    '',
    '## Verdict',
    '',
    `Write \`${VERDICT_FILE}\` next to this file:`,
    '```json',
    `{"round": ${round}, "verdict": "publish|rewrite|reject-derivable|consolidate",`,
    ` "derivedAnswer": "<only for reject-derivable/consolidate>",`,
    ` "notes": ["..."], "textHash": "${hash}"}`,
    '```',
  ];
  writeFileSync(join(input.prDir, REQUEST_FILE), lines.join('\n') + '\n');
}

/** Round stamped in the existing review request (0 when none was issued yet). */
function requestState(prDir: string): { round: number; hash: string | null } {
  const path = join(prDir, REQUEST_FILE);
  if (!existsSync(path)) return { round: 0, hash: null };
  const text = readFileSync(path, 'utf8');
  const round = Number(/^round: (\d+)$/m.exec(text)?.[1] ?? 0);
  const hash = /^textHash: ([0-9a-f]{64})$/m.exec(text)?.[1] ?? null;
  return { round, hash };
}

function readPrTextVerdict(prDir: string): { verdict?: PrTextVerdict; error?: string } {
  const path = join(prDir, VERDICT_FILE);
  if (!existsSync(path)) return {};
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  const v = doc as Partial<PrTextVerdict>;
  if (!Number.isInteger(v.round) || (v.round as number) < 1 || (v.round as number) > 2) {
    return { error: `round must be 1 or 2 (got ${JSON.stringify(v.round)}) — round >2 is invalid shape, the cap is HARD` };
  }
  if (!['publish', 'rewrite', 'reject-derivable', 'consolidate'].includes(v.verdict as string)) {
    return { error: `verdict must be publish|rewrite|reject-derivable|consolidate (got ${JSON.stringify(v.verdict)})` };
  }
  if (!Array.isArray(v.notes) || v.notes.some((n) => typeof n !== 'string')) {
    return { error: 'notes must be a string array' };
  }
  if (typeof v.textHash !== 'string') return { error: 'textHash missing' };
  return { verdict: v as PrTextVerdict };
}

/**
 * The driver-mediated PR-text cold read (§14). State machine over the two
 * agent-writable artifacts in pr/ (the request is TOOL-written; the verdict is
 * agent-written via a context-free subagent — provenance is doctrine-enforced,
 * shape/round/freshness are enforced here):
 *  - text present, no request → write the round-1 request → ERR09.
 *  - request pending, no verdict (or the request's hash went stale before any
 *    verdict) → (re)issue the SAME round with the current hash → ERR09
 *    (rounds are consumed by VERDICTS, never by requests).
 *  - fresh verdict for the current round: publish → pass; rewrite on round 1 →
 *    ERR09 (edit the text; the next attempt issues round 2); rewrite on
 *    round 2 → FINAL, ships as publish-with-caveats (WARN04); round-2 publish
 *    notes also ship as caveats; reject-derivable / consolidate → blocking
 *    with ERR05/ERR06 semantics, surfacing the derivedAnswer.
 *  - stale verdict (text edited after it): round 1 consumed → issue round 2 →
 *    ERR09; round 2 consumed → ERR10_COLDREAD_EXHAUSTED — the tool REFUSES to
 *    emit a round-3 request; restore the reviewed text or take the case back.
 */
export function prTextGate(input: PrTextGateInput): PrTextGateResult {
  const none: PrTextGateResult = { issue: null, warnings: [], caveats: [] };
  const hash = prTextHash(input.title, input.body);
  const req = requestState(input.prDir);
  const { verdict, error } = readPrTextVerdict(input.prDir);

  if (error) {
    return {
      ...none,
      issue: {
        id: 'ERR09_COLDREAD_PENDING',
        detail: `${VERDICT_FILE} invalid: ${error} — fix the verdict for the pending round-${req.round || 1} request`,
      },
    };
  }

  if (!verdict) {
    const round = req.round === 0 ? 1 : req.round;
    if (req.round === 0 || req.hash !== hash) writePrTextRequest(input, round, hash);
    return {
      ...none,
      issue: {
        id: 'ERR09_COLDREAD_PENDING',
        detail:
          `PR-text cold read pending (round ${round}): run a CONTEXT-FREE subagent over ` +
          `${join(input.prDir, REQUEST_FILE)} and have it write ${VERDICT_FILE}`,
      },
    };
  }

  if (verdict.textHash !== hash) {
    // Stale verdict: the text changed after this round's read. The round is
    // consumed; round 2 is the last one, and round 3 is impossible.
    if (verdict.round >= 2) {
      return {
        ...none,
        issue: {
          id: 'ERR10_COLDREAD_EXHAUSTED',
          detail:
            'the round-2 verdict no longer matches the text (edited after the final read) and the two-round cap is HARD — ' +
            'restore the reviewed text or take the case back through resolve',
        },
      };
    }
    writePrTextRequest(input, verdict.round + 1, hash);
    return {
      ...none,
      issue: {
        id: 'ERR09_COLDREAD_PENDING',
        detail:
          `round-${verdict.round} verdict is stale (text edited) — round ${verdict.round + 1} request issued: ` +
          `run the context-free subagent over ${join(input.prDir, REQUEST_FILE)} (round 2 is FINAL)`,
      },
    };
  }

  if (verdict.round < req.round) {
    return {
      ...none,
      issue: {
        id: 'ERR09_COLDREAD_PENDING',
        detail: `verdict answers round ${verdict.round} but round ${req.round} is pending — answer the current request`,
      },
    };
  }

  switch (verdict.verdict) {
    case 'publish':
    case 'rewrite': {
      if (verdict.verdict === 'rewrite' && verdict.round === 1) {
        return {
          ...none,
          issue: {
            id: 'ERR09_COLDREAD_PENDING',
            detail: `cold reader requests a rewrite (round 1): ${verdict.notes.join('; ') || '(no notes)'} — edit title/body; the next attempt issues the round-2 request`,
          },
        };
      }
      // Round-2 rewrite is FINAL and ships as publish-with-caveats; round-2
      // publish notes ship as caveats too (WARN04).
      const caveats = verdict.round === 2 ? verdict.notes.filter((n) => n.trim() !== '') : [];
      const warnings: Issue[] =
        caveats.length > 0
          ? [
              {
                id: 'WARN04_COLDREAD_NOTES',
                detail: `round-2 cold-reader notes ship as '## Caveats (cold reader)' on the PR: ${caveats.join('; ')}`,
              },
            ]
          : [];
      return { issue: null, warnings, caveats };
    }
    case 'reject-derivable':
      return {
        ...none,
        issue: {
          id: 'ERR05_DECIDED_ALREADY',
          detail: `cold reader: this PR should not exist — the answer is derivable: ${verdict.derivedAnswer ?? verdict.notes.join('; ')}`,
        },
      };
    case 'consolidate':
      return {
        ...none,
        issue: {
          id: 'ERR06_DUPLICATE_CASE',
          detail: `cold reader: consolidate with a sibling case: ${verdict.derivedAnswer ?? verdict.notes.join('; ')}`,
        },
      };
  }
}

/** Advisory text checks (WARN01/WARN02) — returned, never blocking. */
export function advisoryTextIssues(title: string, body: string, conflictedPaths: string[]): Issue[] {
  const issues: Issue[] = [];
  const mentions = conflictedPaths.filter((p) => body.includes(p) || body.includes(p.split('/').pop() ?? p));
  const tautology = TAUTOLOGY_PHRASES.find((t) => body.includes(t) || title.includes(t));
  if (mentions.length === 0 || tautology) {
    issues.push({
      id: 'WARN01_TEMPLATE_TEXT',
      detail: tautology
        ? `body/title contains a retired template phrase ("${tautology}") — rewrite from the case materials`
        : 'body references none of the conflicted files — rewrite from the case materials',
    });
  }
  const firstLine = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '');
  if (!firstLine || !/decision|review needed|approv|which|confirm|ask/i.test(firstLine)) {
    issues.push({
      id: 'WARN02_NO_DECISION_LINE',
      detail: 'the first body line carries no ask/decision — open with the exact choice the owner is being asked to make',
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// GitHub REST transport (injectable; §14).
// ---------------------------------------------------------------------------

export interface GithubTransport {
  /** `path` is the full API path+query (e.g. /repos/o/r/pulls). Returns parsed JSON. */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** owner/repo from the origin remote URL (https or ssh forms), or null. */
export function parseGithubSlug(url: string): { owner: string; repo: string } | null {
  const m =
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim()) ?? null;
  return m ? { owner: m[1], repo: m[2] } : null;
}

const GITHUB_HOST = 'api.github.com';

/** CONNECT tunnel through HTTPS_PROXY (the credential proxy swaps Authorization for api.github.com). */
function openTunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { host: `${host}:${port}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else reject(new Error(`proxy CONNECT ${host}:${port} failed: HTTP ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The real transport: node https to api.github.com, Bearer <substitute token>
 * (the proxy swaps the header on the wire), CONNECT-tunnelled through
 * HTTPS_PROXY when set (node's https module does not honour proxy env vars by
 * itself — curl/git do, node does not).
 */
export function realGithubTransport(token: string): GithubTransport {
  return {
    async request(method, path, body) {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null;
      const socket = proxyUrl ? await openTunnel(new URL(proxyUrl), GITHUB_HOST, 443) : undefined;
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          {
            host: GITHUB_HOST,
            port: 443,
            method,
            path,
            ...(socket ? { createConnection: () => tlsConnect({ socket, servername: GITHUB_HOST }) } : {}),
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${token}`,
              'user-agent': 'flsclaw-sweep-publish',
              ...(payload !== undefined
                ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown = null;
              try {
                parsed = text ? JSON.parse(text) : null;
              } catch {
                parsed = text;
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
          },
        );
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
      });
    },
  };
}

/** Blob content as base64 (raw bytes — git() is utf8-only, blobs may not be). */
export async function catBlobBase64(repo: string, oid: string): Promise<string> {
  const res = await execFileP('git', ['-C', repo, 'cat-file', 'blob', oid], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return (res.stdout as Buffer).toString('base64');
}

export interface RemotePublishResult {
  url: string;
  number: number;
  remoteCommit: string;
}

/**
 * Create the fix/sweep ref and the DRAFT PR on GitHub, entirely via the REST
 * API (no `git push` — broken through the proxy). The exhibit's parent is the
 * origin tip, so its tree/commit are buildable remotely: base_tree exists on
 * GitHub already and only the conflicted paths' blobs are uploaded. The
 * author/committer identity+dates mirror the local exhibit commit so the
 * remote sha normally equals the local one; equality is NOT load-bearing.
 */
export async function publishExhibit(
  repo: string,
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  exhibit: Exhibit,
  conflictedPaths: string[],
  fixBranch: string,
  pr: { title: string; body: string; base: string },
): Promise<RemotePublishResult> {
  const api = `/repos/${slug.owner}/${slug.repo}`;
  const expect = async (
    method: string,
    path: string,
    body: unknown,
  ): Promise<Record<string, unknown>> => {
    const res = await transport.request(method, path, body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    return (res.body ?? {}) as Record<string, unknown>;
  };

  // Blobs for every conflicted path present in the exhibit tree; deletions map
  // to sha:null tree entries.
  const treeEntries: Array<{ path: string; mode: string; type: 'blob'; sha: string | null }> = [];
  for (const path of conflictedPaths) {
    const entry = await lsTreeEntry(repo, exhibit.tree, path);
    if (!entry) {
      treeEntries.push({ path, mode: '100644', type: 'blob', sha: null });
      continue;
    }
    const blob = await expect('POST', `${api}/git/blobs`, {
      content: await catBlobBase64(repo, entry.oid),
      encoding: 'base64',
    });
    treeEntries.push({ path, mode: entry.mode, type: 'blob', sha: String(blob.sha) });
  }
  const baseTree = (await git(repo, ['rev-parse', `${exhibit.parent}^{tree}`])).stdout.trim();
  const tree = await expect('POST', `${api}/git/trees`, { base_tree: baseTree, tree: treeEntries });

  const idLines = (
    await git(repo, ['show', '-s', '--format=%an%n%ae%n%aI%n%cn%n%ce%n%cI%n%B', exhibit.commit])
  ).stdout.split('\n');
  const commit = await expect('POST', `${api}/git/commits`, {
    message: idLines.slice(6).join('\n').trimEnd(),
    tree: String(tree.sha),
    parents: [exhibit.parent],
    author: { name: idLines[0], email: idLines[1], date: idLines[2] },
    committer: { name: idLines[3], email: idLines[4], date: idLines[5] },
  });
  await expect('POST', `${api}/git/refs`, { ref: `refs/heads/${fixBranch}`, sha: String(commit.sha) });
  const created = await expect('POST', `${api}/pulls`, {
    title: pr.title,
    body: pr.body,
    head: fixBranch,
    base: pr.base,
    draft: true,
  });
  return { url: String(created.html_url), number: Number(created.number), remoteCommit: String(commit.sha) };
}

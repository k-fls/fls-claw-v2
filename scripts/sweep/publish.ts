/**
 * scripts/sweep/publish.ts — mechanics for `propagate publish --case <id>`
 * (the ONLY sanctioned PR-creation path) and the `propagate push` publication
 * stage (PROPAGATION.md §14, D-048/D-049).
 *
 * Born from the 2026-07-21 forensic reviews of the freeze PRs, corrected the
 * same day by D-049 (MERGE-POLICY.md):
 *  - PR heads are REAL commits pushed by the driver via `git push` (D-049 §5;
 *    unified per D-057): HELD with a marker-clean resolution = the resolved
 *    merge commit (ACTIVE PR — the owner reviews & merges); HELD without one
 *    = the pristine-conflict head (clean-prefix commit + the automerge tree
 *    with its markers, DRAFT PR — no agent edits, the owner resolves fresh);
 *    JUDGED = the real merge commit, published BEFORE the target push so the
 *    push auto-flips the PR to merged (D-040). The 2026-07-21 synthetic
 *    exhibit-head mechanism (and its ERR03/ERR04 asserts) is RETIRED — the
 *    pre-PR height check (checkBaseHeight, ERR14) plus the §14.4 push order
 *    are the guarantees. Refs move via `git push` ONLY; the API is never used
 *    to fabricate refs/commits, and a failing push is ERR15 — a D-046 case-2
 *    owner report, never worked around.
 *  - the driver's template PR prose could never pass its own text gate (a
 *    3-round rewrite loop); the driver NEVER generates prose — the agent
 *    writes pr/title.txt + pr/body.md itself. The two-round PR-text cold read
 *    that once gated this text is RETIRED (D-050: zero unique catches ever;
 *    ~300k tokens/~19 min burned in one batch) — checks on the agent's text
 *    are MECHANICAL only (advisory lint WARNs + ERR05/ERR06); the D-031
 *    catch-list survives as writing rules in the doctrine. The only
 *    driver-written body content is the clearly-delimited D-004 machine block
 *    below the agent's prose (pending-count bookkeeping, refreshed by urges).
 *  - no gate asked "should this PR exist": decidedAlready (ERR05) matches the
 *    conflict against decisions recorded in inventory `prompt.extra_context` /
 *    `decided_paths`; duplicate-signature detection (ERR06) lives in the CLI.
 *
 * Every check returns a machine-readable Issue {id, detail}; ERR* ids block,
 * WARN* ids are advisory. HALT_IDS maps the existing DriverHalt reasons onto
 * the same scheme for run/resolve CLI output. The registry of ids is
 * PROPAGATION.md §14 (single source of truth). ERR03/ERR04 (D-049, the exhibit
 * mechanism) and ERR09/ERR10/WARN04 (D-050, the PR-text cold read) are retired
 * permanently and their numbers are never reused.
 *
 * Network: the GitHub REST API is used for PR creation/comments only (normal
 * API use). Requests go to api.github.com with `Authorization: Bearer
 * <substitute token>` — the proxy swaps the header on the wire — honouring
 * HTTPS_PROXY via a CONNECT tunnel. The transport is injectable
 * (GithubTransport) so tests never touch the network, and a dry-run
 * publish/push never constructs one at all.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import type { Socket } from 'node:net';

import { isAncestor, refExists, revParse } from './git.js';
import type { FeatureEntry } from './types.js';

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
// Pre-PR height check (D-049 §5; replaces the retired exhibit asserts).
// ---------------------------------------------------------------------------

/**
 * ERR14_BASE_BEHIND — the origin base branch must be AT LEAST at the expected
 * pass height before a PR is created on it (D-049 §5); higher is fine (someone
 * else committed), lower or diverged is a halt. In ancestry terms:
 *  - HELD (published AFTER the pass's target pushes, §14.4 order): the local
 *    branch tip must be contained in origin/<branch> — the clean prefix was
 *    pushed, so the draft PR's diff is the case run only.
 *  - JUDGED (published BEFORE the target push): origin must not have DIVERGED
 *    from the local branch, and must NOT already contain the merge commit —
 *    that would mean the target push ran first (order violation; the PR could
 *    never be created, let alone auto-flip).
 */
export async function checkBaseHeight(
  repo: string,
  branch: string,
  mode: 'held' | 'judged',
  headSha: string,
  /**
   * This is a RED-FINISH ESCALATION, where the held rule below does not apply.
   *
   * That rule enforces a PREMISE — "held PRs are published after the pass's
   * target pushes" — and at a red finish the premise is void by construction:
   * the tests failed, so nothing is pushed, so origin is necessarily behind and
   * every held escalation was refused (live 2026-08-05, three of three, which is
   * how this parameter came to exist).
   *
   * The escalation satisfies what the rule PROTECTS — a PR whose diff is the
   * case's own work, not the pass's unpushed and unverified merges — by
   * transplanting the resolution onto origin's actual tip instead. When that
   * transplant conflicts it cannot, and the case ships as a DRAFT with the fat
   * diff journaled (WARN16) and explained. The alternative there is refusing to
   * publish at all, which is the silent drop this whole path exists to end, so
   * the escalation is what stands down the rule — not the head's shape.
   *
   * Divergence is still a halt, in every mode.
   */
  unpushedEscalation = false,
): Promise<Issue | null> {
  const originRef = `origin/${branch}`;
  if (!(await refExists(repo, originRef))) {
    return {
      id: 'ERR14_BASE_BEHIND',
      detail: `no origin ref for base '${branch}' — the target branch must exist on origin before a PR can be based on it (D-049 §5)`,
    };
  }
  const originTip = await revParse(repo, originRef);
  const localTip = await revParse(repo, branch);
  const originAtOrAbove = await isAncestor(repo, localTip, originTip); // includes equal
  const originAtOrBelow = await isAncestor(repo, originTip, localTip);
  if (!originAtOrAbove && !originAtOrBelow) {
    return {
      id: 'ERR14_BASE_BEHIND',
      detail: `origin/${branch} (${originTip.slice(0, 12)}) has DIVERGED from the local branch (${localTip.slice(0, 12)}) — owner escalation, never force-resolve`,
    };
  }
  if (mode === 'held' && !originAtOrAbove && !unpushedEscalation) {
    return {
      id: 'ERR14_BASE_BEHIND',
      detail:
        `origin/${branch} (${originTip.slice(0, 12)}) is BEHIND the expected pass height (local ${localTip.slice(0, 12)}) — ` +
        `HELD PRs are published after the pass's target pushes: run \`propagate push --execute\` first (D-049 §5, §14.4)`,
    };
  }
  if (mode === 'judged' && (await isAncestor(repo, headSha, originTip))) {
    return {
      id: 'ERR14_BASE_BEHIND',
      detail:
        `origin/${branch} already contains the judged merge commit ${headSha.slice(0, 12)} — ` +
        `JUDGED PRs are created BEFORE the target push (D-049 order); nothing to publish against this base`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// D-004 machine block (D-049 decision 8): the ONLY driver-written body content
// on a HELD PR — appended below the agent's prose at publish, refreshed by
// every posted urge. The agent never edits it; the driver never touches the
// prose above it.
// ---------------------------------------------------------------------------

export const MACHINE_BLOCK_BEGIN = '<!-- sweep:d004 -->';
export const MACHINE_BLOCK_END = '<!-- /sweep:d004 -->';

/** Render the D-004 machine block for a HELD PR (pending count behind the freeze). */
export function renderMachineBlock(pendingCount: number, watermark12: string): string {
  return [
    MACHINE_BLOCK_BEGIN,
    '## Sweep status (driver-maintained — do not edit)',
    `Pending upstream commits beyond this freeze: **${pendingCount}** (as of pass ${watermark12}).`,
    'Kept current by posted urge comments (D-004, PROPAGATION.md §14.4).',
    MACHINE_BLOCK_END,
  ].join('\n');
}

/**
 * Body with the machine block set: replaces an existing delimited block, else
 * appends one below the (agent-written) body. Idempotent on the same block.
 */
export function withMachineBlock(body: string, block: string): string {
  const begin = body.indexOf(MACHINE_BLOCK_BEGIN);
  const end = body.indexOf(MACHINE_BLOCK_END);
  if (begin >= 0 && end > begin) {
    return body.slice(0, begin) + block + body.slice(end + MACHINE_BLOCK_END.length);
  }
  return `${body.trimEnd()}\n\n${block}`;
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
// Mechanical text checks (§14). The PR-text cold read (prTextGate, prtext-*
// artifacts, ERR09/ERR10/WARN04) that used to live here is RETIRED by D-050.
// ---------------------------------------------------------------------------

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

/**
 * Markers of a FOREIGN template — one a sweep PR must never be written from.
 * `.github/PULL_REQUEST_TEMPLATE.md` is UPSTREAM's CONTRIBUTION guidance for new
 * skills: it asks for a skill type and whether SKILL.md is under 500 lines,
 * none of which describes a merge resolution or a gate fix. It is also the most
 * template-shaped file in the clone, so an agent told only to "write it
 * yourself" reaches for it (live: PR #61). The driver now hands over an explicit
 * per-case `pr/TEMPLATE.md`; these markers catch the other one being used anyway.
 */
export const FOREIGN_TEMPLATE_MARKERS = [
  'contributing-guide:',
  '## Type of Change',
  'Feature skill',
  'Utility skill',
  'Operational/container skill',
  '## For Skills',
  'SKILL.md is under 500 lines',
  'I tested this skill on a fresh clone',
];

/** Advisory text checks (WARN01/WARN02) — returned, never blocking (D-050: the only text checks besides ERR08). */
export function advisoryTextIssues(title: string, body: string, conflictedPaths: string[]): Issue[] {
  const issues: Issue[] = [];
  const mentions = conflictedPaths.filter((p) => body.includes(p) || body.includes(p.split('/').pop() ?? p));
  const tautology = TAUTOLOGY_PHRASES.find((t) => body.includes(t) || title.includes(t));
  const foreign = FOREIGN_TEMPLATE_MARKERS.find((m) => body.includes(m) || title.includes(m));
  if (mentions.length === 0 || tautology || foreign) {
    issues.push({
      id: 'WARN01_TEMPLATE_TEXT',
      detail: foreign
        ? `body/title came from the WRONG template ("${foreign}" belongs to upstream's contribution guide for new ` +
          `skills) — rewrite it from this case's pr/TEMPLATE.md, the only template that applies here`
        : tautology
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

/**
 * Throwing request helper for driver API writes (normal API use only —
 * PR creation, PR body PATCH, comments; NEVER ref/commit fabrication, D-049).
 */
export async function ghExpect(
  transport: GithubTransport,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await transport.request(method, path, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return (res.body ?? {}) as Record<string, unknown>;
}

export interface RemotePublishResult {
  url: string;
  number: number;
}

/**
 * Create the PR on GitHub for a head branch the DRIVER ALREADY PUSHED via
 * `git push` (D-049 §5 — the API never moves refs). HELD PRs are drafts;
 * JUDGED PRs are non-draft history that the target push auto-flips to merged.
 */
export async function createPullRequest(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  pr: { title: string; body: string; head: string; base: string; draft: boolean },
): Promise<RemotePublishResult> {
  const created = await ghExpect(transport, 'POST', `/repos/${slug.owner}/${slug.repo}/pulls`, {
    title: pr.title,
    body: pr.body,
    head: pr.head,
    base: pr.base,
    draft: pr.draft,
  });
  return { url: String(created.html_url), number: Number(created.number) };
}

/** The open PR whose head is `headBranch` (owner-qualified), or null. */
export async function getOpenPrByHead(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  headBranch: string,
): Promise<{ url: string; number: number } | null> {
  const res = await transport.request(
    'GET',
    `/repos/${slug.owner}/${slug.repo}/pulls?head=${encodeURIComponent(`${slug.owner}:${headBranch}`)}&state=open`,
  );
  if (res.status === 200 && Array.isArray(res.body) && res.body.length > 0) {
    const pr = res.body[0] as { html_url?: string; number?: number };
    return { url: String(pr.html_url ?? ''), number: Number(pr.number ?? 0) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// D-059 — interactive PR review loop primitives (REVIEW-trigger model).
//
// The `sweep-addressed` marker is the STATELESS record of the review loop
// (solves the shared-PAT problem): a driver comment on the held PR carrying
// `<!-- sweep-addressed: <review-id> -->` — the highest SUBMITTED REVIEW id
// the currently-published resolution has addressed (0 before any review; the
// posted value is always a review id actually present on the PR, or 0). The
// trigger is REVIEWS ONLY: a reissue is due iff a submitted non-bot review
// exists with an id above the marker — loose issue comments and standalone
// inline comments NEVER trigger (they feed the reissue dialog, nothing else).
//
// A DRIVER comment is a PR issue-comment carrying the marker AS ITS OWN LINE
// (bot comments are authored by the SAME PAT as the human, so exclusion is by
// CONTENT, never by author) — every driver-posted comment (marker posts AND
// urge comments) must carry it. A quote-reply that merely EMBEDS the marker
// (e.g. "> <!-- sweep-addressed: 3 -->") stays human: only a line that IS the
// marker counts. Because urge comments re-assert the CURRENT value while a
// later republish posts a HIGHER one, the effective addressed id is the MAX
// across all marker occurrences (monotonic — a re-asserted old value never
// regresses the state).
// ---------------------------------------------------------------------------

/** The marker recognized ONLY as its own line (a quote-reply embedding it stays human). */
export const SWEEP_ADDRESSED_LINE_RE = /^<!--\s*sweep-addressed:\s*(\d+)\s*-->$/;

/** Render the sweep-addressed marker for a driver comment (D-059). */
export function renderSweepAddressed(id: number): string {
  return `<!-- sweep-addressed: ${id} -->`;
}

/**
 * The URGE marker: which upstream head a driver urge comment was about.
 *
 * This replaces the sweep ledger's `lastUrgedHead` (2026-08-04). That field was
 * the last surviving reason for a durable local state file, and it was the same
 * mistake D-058 §2 abolished everywhere else: a fact about what is ON ORIGIN,
 * cached locally, where it could go stale, survive a clean-slate, and be read
 * back by a later session as authority. One did exactly that — a 12-day-old
 * `sweep-ledger.json` was reported as the current sweep state while an open pass
 * sat in the same directory.
 *
 * The comment IS the record: if the PR already carries an urge for this head,
 * the urge was posted. Same shape as `sweep-addressed`, same reasoning.
 */
export const SWEEP_URGE_LINE_RE = /^<!--\s*sweep-urge:\s*([0-9a-f]{7,40})\s*-->$/;

export function renderSweepUrge(headSha: string): string {
  return `<!-- sweep-urge: ${headSha} -->`;
}

/** Heads this PR has already been urged about, read from its comments. */
export async function urgedHeads(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<Set<string>> {
  const raw = await ghPaginated(transport, `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`);
  const out = new Set<string>();
  for (const c of raw) {
    const body = String((c as { body?: unknown }).body ?? '');
    for (const line of body.split('\n')) {
      const m = SWEEP_URGE_LINE_RE.exec(line.trim());
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/**
 * The sweep-addressed id carried by `body`, or null when no LINE of the body
 * is exactly the marker (hardened detection: an embedded/quoted occurrence
 * does not count). Multiple marker lines take the MAX.
 *
 * `maxRealReviewId` bounds the marker TO REALITY (D-059 FINAL finding 4): the
 * driver only ever posts 0 or a review id actually present on the PR, so a
 * marker value ABOVE the max real review id cannot be driver-posted — it is a
 * human paste (which would otherwise permanently silence the review loop) and
 * is IGNORED per line. Pass the max submitted-review id when reviews are
 * known; null (default) skips the bound.
 */
export function extractSweepAddressed(body: string, maxRealReviewId: number | null = null): number | null {
  let max: number | null = null;
  for (const line of body.split('\n')) {
    const m = SWEEP_ADDRESSED_LINE_RE.exec(line.trim());
    if (m) {
      const v = Number(m[1]);
      if (maxRealReviewId !== null && v > maxRealReviewId) continue; // not a value the driver could have posted
      if (max === null || v > max) max = v;
    }
  }
  return max;
}

/** The max id over a PR's submitted reviews (0 when none) — the marker's reality bound. */
export function maxRealReviewId(reviews: PrReview[]): number {
  return reviews.reduce((m, r) => Math.max(m, r.id), 0);
}

/** Marker lines removed (the agent's own prior message, served back tag-stripped). */
export function stripSweepAddressed(body: string): string {
  return body
    .split('\n')
    .filter((line) => !SWEEP_ADDRESSED_LINE_RE.test(line.trim()))
    .join('\n')
    .trim();
}

export interface PrComment {
  id: number;
  body: string;
  /** GitHub login of the comment author ('' when unknown). */
  author: string;
  /** ISO created_at ('' when unknown) — the dialog sort key. */
  createdAt: string;
  /** Inline review comments only: the file path the comment anchors to. */
  path?: string;
}

/**
 * Split a PR's issue comments into the review-loop inputs (D-059, pure):
 *  - `humans`: comments WITHOUT an own-line marker (content-based bot exclusion);
 *  - `driver`: comments WITH the marker (the agent's own prior messages);
 *  - `markerId`: the effective sweep-addressed REVIEW id — MAX over every
 *    marker occurrence (null when no marker was ever posted).
 *
 * `maxRealReviewId` (finding 4): when the PR's reviews are known, pass their
 * max id — marker values above it are IGNORED (see extractSweepAddressed), so
 * a human pasting `<!-- sweep-addressed: 999999999 -->` neither silences the
 * loop nor gets their comment mislabeled as an agent turn.
 */
export function classifyComments(
  comments: PrComment[],
  maxRealReviewId: number | null = null,
): {
  humans: PrComment[];
  driver: PrComment[];
  markerId: number | null;
} {
  const humans: PrComment[] = [];
  const driver: PrComment[] = [];
  let markerId: number | null = null;
  for (const c of comments) {
    const v = extractSweepAddressed(c.body, maxRealReviewId);
    if (v !== null) {
      driver.push(c);
      if (markerId === null || v > markerId) markerId = v;
    } else {
      humans.push(c);
    }
  }
  return { humans, driver, markerId };
}

/** A submitted PR review (D-059 trigger unit). */
export interface PrReview {
  id: number;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | ... */
  state: string;
  body: string;
  author: string;
  submittedAt: string;
}

/**
 * The review-trigger classification (D-059 FINAL, pure): reissue is due iff a
 * SUBMITTED non-bot review exists whose id is above the sweep-addressed marker
 * (or any such review exists and no marker was ever posted). `latest` is the
 * newest such review — its STATE drives the action table (APPROVED → land /
 * re-resolve; CHANGES_REQUESTED / COMMENTED / other → reissue, forced HELD).
 * `*[bot]`-authored reviews never trigger, and neither do DISMISSED ones (a
 * dismissal has nothing actionable — the start loop advances the marker past
 * it instead of reissuing; an earlier non-dismissed review above the marker
 * still triggers normally).
 *
 * The marker value is bounded by construction on the WRITE side (the driver
 * only ever posts real review ids, or 0) — but comments are world-writable, so
 * the bound is also ENFORCED on the READ side: the caller derives `markerId`
 * via classifyComments with the max real review id, which ignores any pasted
 * marker above it. A (real) marker at/above the newest review id then simply
 * reads as "nothing new".
 */
export function classifyReviewTrigger(
  reviews: PrReview[],
  markerId: number | null,
): { latest: PrReview | null; maxReviewId: number | null; reissueDue: boolean } {
  const human = reviews.filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED' && !r.author.endsWith('[bot]'));
  if (human.length === 0) return { latest: null, maxReviewId: null, reissueDue: false };
  const latest = human.reduce((a, b) => (b.id > a.id ? b : a));
  return { latest, maxReviewId: latest.id, reissueDue: markerId === null || latest.id > markerId };
}

/**
 * FAIL-CLOSED paginated GET of a list endpoint: follows pages (per_page=100)
 * until exhausted — GitHub returns oldest-first, so stopping at page 1 would
 * TRUNCATE THE NEWEST items (the review-loop truncation bug). Any non-200 (or
 * a non-array body) THROWS — the caller maps it to ERR13; a flaky API must
 * never read as "no items".
 */
export async function ghPaginated(transport: GithubTransport, path: string): Promise<unknown[]> {
  const items: unknown[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const res = await transport.request('GET', `${path}${sep}per_page=100&page=${page}`);
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new Error(`paginated GET ${path} (page ${page}) -> HTTP ${res.status}`);
    }
    items.push(...res.body);
    if (res.body.length < 100) return items;
  }
}

/** FAIL-CLOSED, PAGINATED list of a PR's issue comments (D-059). Throws on failure (ERR13). */
export async function listIssueComments(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<PrComment[]> {
  const raw = await ghPaginated(transport, `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`);
  return (raw as Array<{ id?: number; body?: string; user?: { login?: string }; created_at?: string }>).map((c) => ({
    id: Number(c.id ?? 0),
    body: String(c.body ?? ''),
    author: String(c.user?.login ?? ''),
    createdAt: String(c.created_at ?? ''),
  }));
}

/** FAIL-CLOSED, PAGINATED list of a PR's INLINE review comments (D-059 dialog feed). */
export async function listReviewComments(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<PrComment[]> {
  const raw = await ghPaginated(transport, `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/comments`);
  return (raw as Array<{ id?: number; body?: string; user?: { login?: string }; created_at?: string; path?: string }>).map(
    (c) => ({
      id: Number(c.id ?? 0),
      body: String(c.body ?? ''),
      author: String(c.user?.login ?? ''),
      createdAt: String(c.created_at ?? ''),
      ...(c.path ? { path: String(c.path) } : {}),
    }),
  );
}

/**
 * FAIL-CLOSED, PAGINATED list of a PR's SUBMITTED reviews (D-059 trigger).
 * PENDING (unsubmitted) reviews are dropped here; bot exclusion is the
 * trigger's job (`classifyReviewTrigger` — bots stay visible to the dialog).
 */
export async function listReviews(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<PrReview[]> {
  const raw = await ghPaginated(transport, `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/reviews`);
  return (raw as Array<{ id?: number; state?: string; body?: string; user?: { login?: string }; submitted_at?: string }>)
    .map((r) => ({
      id: Number(r.id ?? 0),
      state: String(r.state ?? ''),
      body: String(r.body ?? ''),
      author: String(r.user?.login ?? ''),
      submittedAt: String(r.submitted_at ?? ''),
    }))
    .filter((r) => r.state !== 'PENDING');
}

export interface PrByHead {
  number: number;
  url: string;
  state: string;
  /** Set when the PR was merged (state is 'closed' for merged PRs too — NEVER reopen these). */
  mergedAt: string | null;
  /** The PR description (the agent's own opening turn in the reissue dialog). */
  body: string;
  createdAt: string;
}

/**
 * FAIL-CLOSED PR lookup by head branch across ALL states (D-059 start
 * classification needs open vs closed-unmerged vs merged vs none): non-200 /
 * non-array THROWS (ERR13 at the caller) — never "no PR" on an API failure.
 */
export async function getPrsByHead(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  headBranch: string,
): Promise<PrByHead[]> {
  const res = await transport.request(
    'GET',
    `/repos/${slug.owner}/${slug.repo}/pulls?head=${encodeURIComponent(`${slug.owner}:${headBranch}`)}&state=all`,
  );
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(`PR lookup (state=all) for '${headBranch}' -> HTTP ${res.status}`);
  }
  return (
    res.body as Array<{
      number?: number;
      html_url?: string;
      state?: string;
      merged_at?: string | null;
      body?: string | null;
      created_at?: string;
    }>
  ).map((pr) => ({
    number: Number(pr.number ?? 0),
    url: String(pr.html_url ?? ''),
    state: String(pr.state ?? ''),
    mergedAt: pr.merged_at ? String(pr.merged_at) : null,
    body: String(pr.body ?? ''),
    createdAt: String(pr.created_at ?? ''),
  }));
}

/** LIVE single-PR state (finish re-checks before landing/publishing). Throws on failure (ERR13). */
export async function getPullRequest(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<{ number: number; url: string; state: string; merged: boolean; draft: boolean; title: string }> {
  const pr = await ghExpect(transport, 'GET', `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}`);
  return {
    number: Number(pr.number ?? prNumber),
    url: String(pr.html_url ?? ''),
    state: String(pr.state ?? ''),
    merged: pr.merged === true,
    draft: pr.draft === true,
    title: String(pr.title ?? ''),
  };
}

/**
 * Reopen a closed-NOT-MERGED PR (D-059 case 4 — replaces the D-058 ref delete).
 * The caller MUST have excluded merged PRs (GitHub 422s a reopen of a merged
 * PR — the ERR13 halt this guard retired). Throws on failure (ERR13).
 */
export async function reopenPullRequest(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<void> {
  await ghExpect(transport, 'PATCH', `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}`, { state: 'open' });
}

/**
 * Post the sweep-addressed marker comment (D-059): the driver records the
 * highest SUBMITTED REVIEW id the just-published resolution addressed (0 for a
 * first publish — no review yet; otherwise always a review id actually present
 * on the PR at classification time). Append-only: a fresh comment is posted
 * each (re)publish and readers take the MAX (`classifyComments`), so no
 * review-id bookkeeping is needed. Throws on failure (ERR13 at the caller).
 */
export async function postSweepAddressed(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
  addressedId: number,
): Promise<void> {
  const body = [
    `Sweep bookkeeping (driver-posted): the published resolution addresses PR reviews up to id ${addressedId}.`,
    renderSweepAddressed(addressedId),
  ].join('\n');
  await ghExpect(transport, 'POST', `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`, { body });
}

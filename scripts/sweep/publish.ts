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
  if (mode === 'held' && !originAtOrAbove) {
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

/** Advisory text checks (WARN01/WARN02) — returned, never blocking (D-050: the only text checks besides ERR08). */
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
// D-059 — interactive PR review loop primitives.
//
// The `sweep-addressed` marker is the STATELESS record of the review loop
// (solves the shared-PAT problem): a driver comment on the held PR carrying
// `<!-- sweep-addressed: <comment-id> -->` — the highest HUMAN PR-comment id
// the currently-published resolution has addressed. A HUMAN comment is a PR
// issue-comment whose body does NOT contain the marker: bot comments (authored
// by the SAME PAT as the human) are excluded by CONTENT, never by author — so
// EVERY driver-posted comment (marker posts AND urge comments) must carry the
// marker. Because urge comments re-assert the CURRENT value while a later
// republish posts a HIGHER one, the effective addressed id is the MAX across
// all marker occurrences (monotonic — a re-asserted old value never regresses
// the state).
// ---------------------------------------------------------------------------

export const SWEEP_ADDRESSED_RE = /<!--\s*sweep-addressed:\s*(\d+)\s*-->/;

/** Render the sweep-addressed marker for a driver comment (D-059). */
export function renderSweepAddressed(id: number): string {
  return `<!-- sweep-addressed: ${id} -->`;
}

export interface PrComment {
  id: number;
  body: string;
}

/**
 * Split a PR's issue comments into the review-loop inputs (D-059, pure):
 *  - `humans`: comments WITHOUT the marker (content-based bot exclusion);
 *  - `lastHumanId`: the newest human comment id (null when none);
 *  - `markerId`: the effective sweep-addressed id — MAX over every marker
 *    occurrence (null when no marker was ever posted).
 */
export function classifyComments(comments: PrComment[]): {
  humans: PrComment[];
  lastHumanId: number | null;
  markerId: number | null;
} {
  const humans: PrComment[] = [];
  let lastHumanId: number | null = null;
  let markerId: number | null = null;
  for (const c of comments) {
    const m = SWEEP_ADDRESSED_RE.exec(c.body);
    if (m) {
      const v = Number(m[1]);
      if (markerId === null || v > markerId) markerId = v;
    } else {
      humans.push(c);
      if (lastHumanId === null || c.id > lastHumanId) lastHumanId = c.id;
    }
  }
  return { humans, lastHumanId, markerId };
}

/**
 * FAIL-CLOSED list of a PR's issue comments (D-059): any non-200 (or a
 * non-array body) THROWS — the caller maps it to ERR13. A flaky API must never
 * read as "no comments" and mis-classify a commented PR as review-quiet.
 */
export async function listIssueComments(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<PrComment[]> {
  const res = await transport.request(
    'GET',
    `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments?per_page=100`,
  );
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(`comment list for PR #${prNumber} -> HTTP ${res.status}`);
  }
  return (res.body as Array<{ id?: number; body?: string }>).map((c) => ({
    id: Number(c.id ?? 0),
    body: String(c.body ?? ''),
  }));
}

export interface PrByHead {
  number: number;
  url: string;
  state: string;
}

/**
 * FAIL-CLOSED PR lookup by head branch across ALL states (D-059 start
 * classification needs open vs closed vs none): non-200 / non-array THROWS
 * (ERR13 at the caller) — never "no PR" on an API failure.
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
  return (res.body as Array<{ number?: number; html_url?: string; state?: string }>).map((pr) => ({
    number: Number(pr.number ?? 0),
    url: String(pr.html_url ?? ''),
    state: String(pr.state ?? ''),
  }));
}

/** Reopen a closed-not-merged PR (D-059 case 4 — replaces the D-058 ref delete). Throws on failure (ERR13). */
export async function reopenPullRequest(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<void> {
  await ghExpect(transport, 'PATCH', `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}`, { state: 'open' });
}

/**
 * Post the sweep-addressed marker comment (D-059): the driver records the
 * highest human comment id the just-published resolution addressed (0 for a
 * first publish — nothing addressed yet). Append-only: a fresh comment is
 * posted each (re)publish and readers take the MAX (`classifyComments`), so no
 * comment-id bookkeeping is needed. Throws on failure (ERR13 at the caller).
 */
export async function postSweepAddressed(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
  addressedId: number,
): Promise<void> {
  const body = [
    `Sweep bookkeeping (driver-posted): the published resolution addresses PR comments up to id ${addressedId}.`,
    renderSweepAddressed(addressedId),
  ].join('\n');
  await ghExpect(transport, 'POST', `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`, { body });
}

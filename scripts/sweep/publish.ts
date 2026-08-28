/**
 * scripts/sweep/publish.ts — mechanics for `propagate publish --case <id>`
 * (the ONLY sanctioned PR-creation path) and the `propagate push` publication
 * stage (DRIVER.md §10).
 *
 *  - PR heads are REAL commits pushed by the driver via `git push`: HELD with
 *    a marker-clean resolution = the resolved merge commit (ACTIVE PR — the
 *    owner reviews & merges); HELD without one = the pristine-conflict head
 *    (clean-prefix commit + the automerge tree with its markers, DRAFT PR —
 *    no agent edits, the owner resolves fresh); JUDGED = the real merge
 *    commit, published BEFORE the target push so the push auto-flips the PR
 *    to merged. The pre-PR height check (checkBaseHeight, ERR14) plus the
 *    §14.4 push order are the guarantees. Refs move via `git push` ONLY; the
 *    API is never used to fabricate refs/commits, and a failing push is
 *    ERR15 — an owner report, never worked around.
 *  - the driver NEVER generates prose — the agent writes pr/title.txt +
 *    pr/body.md itself; checks on the agent's text are MECHANICAL only
 *    (advisory lint WARNs + ERR06). The only driver-written body content is
 *    the clearly-delimited machine block below the agent's prose
 *    (pending-count bookkeeping, refreshed by urges).
 *  - "should this PR exist" is answered by duplicate-signature detection
 *    (ERR06, in the CLI) and by the PR channel itself.
 *
 * Every check returns a machine-readable Issue {id, detail}; ERR* ids block,
 * WARN* ids are advisory. HALT_IDS maps DriverHalt reasons onto the same
 * scheme for run/resolve CLI output. The registry of ids is DRIVER.md
 * §11 (single source of truth), including the reserved numbers that must
 * never be assigned.
 *
 * Network: the GitHub REST API is used for PR creation/comments only (normal
 * API use). Requests go to api.github.com with `Authorization: Bearer
 * <substitute token>` — the proxy swaps the header on the wire — honouring
 * HTTPS_PROXY via a CONNECT tunnel. The transport is injectable
 * (GithubTransport) so tests never touch the network, and a dry-run
 * publish/push never constructs one at all.
 */
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { isAncestor, refExists, revParse } from './git.js';

// ---------------------------------------------------------------------------
// Result ids (DRIVER.md §11). ERR* blocks, WARN* is advisory. The full registry
// with meanings + prescribed agent actions lives in DRIVER.md §11 and the
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
  // The pass cannot build an environment from committed, valid manifests. No
  // tree can be checked, so no case can be served and no verdict is admissible.
  'environment-unusable': 'ERR47_ENVIRONMENT_UNUSABLE',
};

export function haltIdFor(reason: string): string | null {
  return HALT_IDS[reason] ?? null;
}

// ---------------------------------------------------------------------------
// Pre-PR height check (DRIVER.md §10.4).
// ---------------------------------------------------------------------------

/**
 * ERR14_BASE_BEHIND — the origin base branch must be AT LEAST at the expected
 * pass height before a PR is created on it (DRIVER.md §10.4); higher is fine (someone
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
   * every held escalation would be refused.
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
      detail: `no origin ref for base '${branch}' — the target branch must exist on origin before a PR can be based on it`,
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
        `HELD PRs are published after the pass's target pushes, which happen at \`finish\``,
    };
  }
  if (mode === 'judged' && (await isAncestor(repo, headSha, originTip))) {
    return {
      id: 'ERR14_BASE_BEHIND',
      detail:
        `origin/${branch} already contains the judged merge commit ${headSha.slice(0, 12)} — ` +
        `JUDGED PRs are created BEFORE the target push; nothing to publish against this base`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The machine block (`sweep:d004` markers, DRIVER.md §5.5): the ONLY
// driver-written body content on a HELD PR — appended below the agent's prose
// at publish, refreshed by every posted urge. The agent never edits it; the
// driver never touches the prose above it.
// ---------------------------------------------------------------------------

export const MACHINE_BLOCK_BEGIN = '<!-- sweep:d004 -->';
export const MACHINE_BLOCK_END = '<!-- /sweep:d004 -->';

/** Render the machine block for a HELD PR (pending count behind the freeze). */
export function renderMachineBlock(pendingCount: number, watermark12: string): string {
  return [
    MACHINE_BLOCK_BEGIN,
    '## Sweep status (driver-maintained — do not edit)',
    `Pending upstream commits beyond this freeze: **${pendingCount}** (as of pass ${watermark12}).`,
    'Kept current by posted urge comments.',
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
// Mechanical text checks (§14).
// ---------------------------------------------------------------------------

/**
 * Boilerplate phrases that mark a machine-templated PR body — the agent must
 * write its own prose; their presence is WARN01_TEMPLATE_TEXT.
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
 * yourself" reaches for it. The driver hands over an explicit per-case
 * `pr/TEMPLATE.md`; these markers catch the other one being used anyway.
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

/** Advisory text checks (WARN01/WARN02) — returned, never blocking (DRIVER.md §10.5: the only text checks besides ERR08). */
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
          ? `body/title contains a banned template phrase ("${tautology}") — rewrite from the case materials`
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

/**
 * CONNECT tunnel through HTTPS_PROXY (the credential proxy swaps Authorization
 * for api.github.com), written straight onto a raw socket.
 *
 * WHY NOT `node:http`'s request + 'connect' event. That is the idiomatic form
 * and it works under node — but the agent runs `finish` under BUN as often as
 * under tsx, and Bun's node:http shim cannot express CONNECT: it builds a fetch
 * URL from `path`, `api.github.com:443` is not a path, and it fails with
 * `fetch() URL is invalid` — under Bun, every publish is refused. The runtime
 * the agent happens to type is not something the driver may depend on.
 *
 * CONNECT is a request line and a blank line; doing it by hand costs a few
 * lines and works on any runtime with a TCP socket.
 */
function openTunnel(proxy: URL, host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(Number(proxy.port || 80), proxy.hostname);
    const fail = (e: Error): void => {
      socket.destroy();
      reject(e);
    };
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        // A proxy that never completes the header would hang forever otherwise.
        if (head.length > 64 * 1024) fail(new Error('proxy CONNECT response header too large'));
        return;
      }
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      if (status !== 200) {
        fail(new Error(`proxy CONNECT ${host}:${port} failed: HTTP ${status || head.split('\r\n')[0]}`));
        return;
      }
      // Anything after the header belongs to the tunnelled stream — push it back
      // so the TLS handshake does not lose its first bytes.
      const rest = head.slice(end + 4);
      if (rest.length > 0) socket.unshift(Buffer.from(rest, 'latin1'));
      resolve(socket);
    };
    socket.on('data', onData);
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
 * PR creation, PR body PATCH, comments; NEVER ref/commit fabrication — DRIVER.md §2.5).
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
 * `git push` (DRIVER.md §2.5 — the API never moves refs). HELD PRs are drafts;
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
// Interactive PR review loop primitives (REVIEW-trigger model, DRIVER.md §5.3).
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

/** Render the sweep-addressed marker for a driver comment. */
export function renderSweepAddressed(id: number): string {
  return `<!-- sweep-addressed: ${id} -->`;
}

/**
 * The URGE marker: which upstream head a driver urge comment was about.
 *
 * The comment IS the record: if the PR already carries an urge for this head,
 * the urge was posted. There is deliberately NO durable local bookkeeping for
 * this — a fact about what is ON ORIGIN, cached locally, can go stale, survive
 * a clean-slate, and be read back by a later session as authority. Same shape
 * as `sweep-addressed`, same reasoning.
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
 * `maxRealReviewId` bounds the marker TO REALITY: the
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
 * Split a PR's issue comments into the review-loop inputs (pure):
 *  - `humans`: comments WITHOUT an own-line marker (content-based bot exclusion);
 *  - `driver`: comments WITH the marker (the agent's own prior messages);
 *  - `markerId`: the effective sweep-addressed REVIEW id — MAX over every
 *    marker occurrence (null when no marker was ever posted).
 *
 * `maxRealReviewId`: when the PR's reviews are known, pass their
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

/** A submitted PR review (the review-loop trigger unit). */
export interface PrReview {
  id: number;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | ... */
  state: string;
  body: string;
  author: string;
  submittedAt: string;
}

/**
 * The review-trigger classification (pure): reissue is due iff a
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

/** FAIL-CLOSED, PAGINATED list of a PR's issue comments. Throws on failure (ERR13). */
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

/** FAIL-CLOSED, PAGINATED list of a PR's INLINE review comments (the reissue dialog feed). */
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
 * FAIL-CLOSED, PAGINATED list of a PR's SUBMITTED reviews (the review-loop trigger).
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
 * FAIL-CLOSED PR lookup by head branch across ALL states (the start
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
 * Reopen a closed-NOT-MERGED PR (the start classification's closed-unmerged
 * case). The caller MUST have excluded merged PRs — GitHub 422s a reopen of a
 * merged PR, which this guard forecloses. Throws on failure (ERR13).
 */
export async function reopenPullRequest(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<void> {
  await ghExpect(transport, 'PATCH', `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}`, { state: 'open' });
}

/**
 * GraphQL request over the SAME transport as every REST call — `/graphql` is
 * another path on the same host, so the token, the proxy tunnel and the
 * fail-closed error handling are shared rather than reimplemented.
 *
 * GraphQL answers HTTP 200 with an `errors` array when the mutation FAILED, so
 * a status check alone reads a refusal as a success. This throws on either.
 */
export async function ghGraphql(
  transport: GithubTransport,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await transport.request('POST', '/graphql', { query, variables });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`POST /graphql -> HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const payload = (res.body ?? {}) as { data?: Record<string, unknown>; errors?: unknown };
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`POST /graphql -> GraphQL error: ${JSON.stringify(payload.errors).slice(0, 300)}`);
  }
  return payload.data ?? {};
}

/**
 * The PR's GraphQL node id, read from the REST resource the driver already
 * fetches. The draft mutations are keyed by node id and nothing else, and REST
 * hands it over on the ordinary PR GET — so this needs no second lookup route
 * and no separate client.
 */
export async function pullRequestNodeId(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<string> {
  const pr = await ghExpect(transport, 'GET', `/repos/${slug.owner}/${slug.repo}/pulls/${prNumber}`);
  const id = typeof pr.node_id === 'string' ? pr.node_id : '';
  if (!id) throw new Error(`PR #${prNumber} carries no node_id — the draft mutation has nothing to address`);
  return id;
}

/**
 * Convert an open PR to a DRAFT. REST cannot do this at all — the draft flag is
 * write-only through GraphQL — which is why this one surface exists.
 *
 * The draft flag is the driver's "already told you" marker on an owner's PR, so
 * the caller converts only a PR that is not already a draft and the next pass
 * stays silent.
 */
export async function convertPullRequestToDraft(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<void> {
  const pullRequestId = await pullRequestNodeId(transport, slug, prNumber);
  await ghGraphql(
    transport,
    'mutation($pullRequestId: ID!) { convertPullRequestToDraft(input: {pullRequestId: $pullRequestId}) { pullRequest { isDraft } } }',
    { pullRequestId },
  );
}

/** Take a PR out of draft. The inverse mutation, same constraints. */
export async function markPullRequestReadyForReview(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
): Promise<void> {
  const pullRequestId = await pullRequestNodeId(transport, slug, prNumber);
  await ghGraphql(
    transport,
    'mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { isDraft } } }',
    { pullRequestId },
  );
}

/**
 * Post the sweep-addressed marker comment: the driver records the
 * highest SUBMITTED REVIEW id the just-published resolution addressed.
 * Append-only — a fresh comment is posted each republish and readers take the
 * MAX (`classifyComments`), so no review-id bookkeeping is needed. Throws on
 * failure (ERR13 at the caller).
 *
 * NOTHING IS POSTED WHEN THERE IS NOTHING TO ADDRESS (`addressedId` 0 — a first
 * publish, no review yet). The marker is bookkeeping between the driver and
 * itself; a PR with no reviewer feedback has nothing for it to record, and a
 * comment on a freshly-opened PR saying the resolution "addresses PR reviews up
 * to id 0" is driver internals printed into the owner's PR, meaning nothing to
 * the person reading it. `classifyComments` already treats an absent marker as
 * 0, so not posting is exactly equivalent.
 *
 * The marker is posted bare, with no prose line: what the driver needs is the
 * machine marker, and a human-readable gloss on a number that is not for humans
 * helps no one.
 */
export async function postSweepAddressed(
  transport: GithubTransport,
  slug: { owner: string; repo: string },
  prNumber: number,
  addressedId: number,
): Promise<void> {
  if (addressedId <= 0) return;
  await ghExpect(transport, 'POST', `/repos/${slug.owner}/${slug.repo}/issues/${prNumber}/comments`, {
    body: renderSweepAddressed(addressedId),
  });
}

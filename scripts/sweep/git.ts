/**
 * scripts/sweep/git.ts — git plumbing helpers for the sweep toolkit.
 *
 * All invocations go through execFile (argv arrays, no shell interpolation).
 * Conflict detection uses NEW-STYLE `git merge-tree --write-tree` (full ort,
 * virtual multi-base). NEVER pass `--merge-base=<x>`: single-base previews
 * report bogus conflicts on branches with two merge bases.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/** Deterministic identity for plumbing-created commits (state journal, merge commits). */
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'flsclaw-sweep',
  GIT_AUTHOR_EMAIL: 'sweep@flsclaw.invalid',
  GIT_COMMITTER_NAME: 'flsclaw-sweep',
  GIT_COMMITTER_EMAIL: 'sweep@flsclaw.invalid',
};

export class GitError extends Error {
  constructor(
    public args: string[],
    public code: number,
    public stderr: string,
    public stdout: string,
  ) {
    super(`git ${args.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitOptions {
  /** Exit codes (besides 0) to return instead of throwing. */
  allowCodes?: number[];
  input?: string | Buffer;
  env?: Record<string, string>;
  cwd?: string;
}

export async function git(repo: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const fullArgs = ['-C', opts.cwd ?? repo, ...args];
  try {
    const child = execFileP('git', fullArgs, {
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...COMMIT_ENV, ...opts.env },
    });
    if (opts.input !== undefined && child.child.stdin) {
      child.child.stdin.write(opts.input);
      child.child.stdin.end();
    }
    const { stdout, stderr } = await child;
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    if (opts.allowCodes?.includes(code)) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code };
    }
    throw new GitError(fullArgs, code, e.stderr ?? '', e.stdout ?? '');
  }
}

export async function revParse(repo: string, ref: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`])).stdout.trim();
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowCodes: [1] })).code === 0;
}

export async function listTreePaths(repo: string, ref: string, subdir?: string): Promise<string[]> {
  const args = ['ls-tree', '-r', '--name-only', ref];
  if (subdir) args.push('--', subdir);
  const res = await git(repo, args, { allowCodes: [128] });
  if (res.code !== 0) return [];
  return res.stdout.split('\n').filter(Boolean);
}

export async function localBranches(repo: string): Promise<string[]> {
  const res = await git(repo, ['branch', '--list', '--format=%(refname:short)']);
  return res.stdout.split('\n').filter(Boolean);
}

/**
 * Branch names present on a remote (refs/remotes/<remote>/*, HEAD excluded),
 * WITHOUT the remote prefix. Input to the remote-branch scope rule
 * (DRIVER.md §4.7): an inventory branch with no local ref but an existing
 * origin/<branch> is still in scope.
 */
export async function remoteBranches(repo: string, remote = 'origin'): Promise<string[]> {
  const prefix = `refs/remotes/${remote}/`;
  const res = await git(repo, ['for-each-ref', '--format=%(refname)', prefix.slice(0, -1)]);
  return res.stdout
    .split('\n')
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length))
    .filter((b) => b !== '' && b !== 'HEAD');
}

/**
 * True when refs/heads/<branch> exists — a LOCAL branch specifically, never a
 * tag or remote-tracking fallback (rev-parse's ref search order would accept
 * those). Used by the §13 sync step to decide materialize vs fast-forward.
 */
export async function localBranchExists(repo: string, branch: string): Promise<boolean> {
  const res = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowCodes: [1] });
  return res.code === 0;
}

export interface MergeTreeResult {
  clean: boolean;
  treeOid: string;
  conflictFiles: string[];
}

/**
 * New-style merge-tree preview. Full ort merge with virtual multi-base;
 * returns the conflicted file list without touching any worktree or index.
 *
 * DETERMINISM: the written automerge tree must be reproducible
 * across invocations, clones and user git configs, because the driver records
 * it and re-verifies against it at resolve. Two sources of nondeterminism are
 * neutralized here, the single choke point: (a) conflict-marker LINES embed the
 * command-line labels verbatim, so a ref NAME and its SHA produce different
 * blobs/trees — we rev-parse both args to full SHAs first; (b) an inherited
 * `merge.conflictStyle=diff3/zdiff3` adds a `|||||||` base section — we force
 * `-c merge.conflictStyle=merge`. Clean merges have no markers, so neither
 * affects clean/no-op trees.
 */
export async function newStyleMergeTree(repo: string, ours: string, theirs: string): Promise<MergeTreeResult> {
  const oursSha = await revParse(repo, ours);
  const theirsSha = await revParse(repo, theirs);
  const res = await git(
    repo,
    ['-c', 'merge.conflictStyle=merge', 'merge-tree', '--write-tree', '--name-only', oursSha, theirsSha],
    { allowCodes: [1] },
  );
  const lines = res.stdout.split('\n');
  const treeOid = lines[0]?.trim() ?? '';
  if (res.code === 0) return { clean: true, treeOid, conflictFiles: [] };
  // Conflicted-file section: lines after the OID up to the first blank line.
  const conflictFiles: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') break;
    // Unquote paths with special characters (git c-quotes them).
    conflictFiles.push(line.startsWith('"') ? JSON.parse(line) : line);
  }
  return { clean: false, treeOid, conflictFiles: [...new Set(conflictFiles)] };
}

/**
 * Replay ONE commit's own delta on top of another commit — a cherry-pick preview
 * that leaves the caller's worktree and index untouched.
 *
 * WHY NOT `merge-tree --merge-base=`. That option requires git 2.40 and the
 * agent container runs 2.39.5, where it exits 129 ("unknown option") — taking
 * the caller down with no result. Local tests cannot catch that class of
 * failure: dev boxes run a newer git. A cherry-pick in a
 * throwaway worktree needs nothing newer than git 2.x and expresses the intent
 * directly: take what THIS commit changed, and only that, onto `onto`.
 *
 * Plain `merge-tree ours theirs` is not a substitute: it lets git pick the base,
 * and when `onto` is an ancestor of `commit` the base IS `onto`, so "theirs"
 * wins wholesale and the result is `commit`'s entire tree — every intervening
 * commit dragged along, which is the bug this exists to avoid.
 *
 * A merge commit is replayed against its FIRST parent (`-m 1`), which is the
 * branch tip for the two-parent resolution heads the publisher builds.
 */
export async function replayCommitOnto(repo: string, commit: string, onto: string): Promise<MergeTreeResult> {
  const commitSha = await revParse(repo, commit);
  const ontoSha = await revParse(repo, onto);
  const parents = (await git(repo, ['rev-list', '--parents', '-n', '1', commitSha])).stdout.trim().split(/\s+/);
  const isMerge = parents.length > 2; // self + 2 parents
  const wt = await addTempWorktree(repo, ontoSha);
  try {
    const res = await git(
      repo,
      ['cherry-pick', '--no-commit', ...(isMerge ? ['-m', '1'] : []), commitSha],
      { cwd: wt.path, allowCodes: [1, 128] },
    );
    if (res.code !== 0) {
      const conflictFiles = (await git(repo, ['diff', '--name-only', '--diff-filter=U'], { cwd: wt.path })).stdout
        .split('\n')
        .filter(Boolean);
      await git(repo, ['cherry-pick', '--abort'], { cwd: wt.path, allowCodes: [1, 128] });
      // A non-zero exit with NO unmerged paths is a failure to run at all (bad
      // object, unborn worktree) — never report it as a clean replay.
      return { clean: false, treeOid: '', conflictFiles: [...new Set(conflictFiles)] };
    }
    const treeOid = (await git(repo, ['write-tree'], { cwd: wt.path })).stdout.trim();
    return { clean: true, treeOid, conflictFiles: [] };
  } finally {
    await wt.remove();
  }
}

/**
 * First-parent chain of `ref` excluding commits reachable from `not`, OLDEST first.
 *
 * ORDER IS LOAD-BEARING, AND IT IS A HISTORY ORDER — NOT A DATE ONE. Every
 * consumer walks this list as a sequence of CUT POINTS: heights.ts numbers the
 * watermarks from it, interval.ts/steps.ts pick the next merge target off it,
 * scan.ts and stop-points.ts step through it. A commit listed BEFORE one it
 * descends from turns a legal cut into a merge of the future.
 *
 * `--reverse` alone yields COMMIT-DATE order. That is safe here ONLY because
 * `--first-parent` restricts the traversal to a single linear chain, where there
 * are no parallel lines to misorder — safety by ACCIDENT, not by construction.
 * `--topo-order` states the requirement explicitly, so widening the traversal
 * later (dropping `--first-parent`, following a second parent) cannot silently
 * reintroduce date ordering.
 *
 * THE FAILURE SHAPE THIS FORECLOSES: once the traversal is widened, a commit
 * whose COMMIT date was refreshed by a rebase can land in date order several
 * positions AHEAD of the branch's own root commit, while topological order
 * puts it behind — and when neither commit is an ancestor of the other, no
 * consumer can recover the right order from the list itself.
 */
export async function firstParentChain(repo: string, ref: string, not: string): Promise<string[]> {
  const res = await git(repo, ['rev-list', '--first-parent', '--topo-order', '--reverse', ref, `^${not}`]);
  return res.stdout.split('\n').filter(Boolean);
}

/**
 * Commits in `from..to` that have `from` as an ancestor — the descendants of
 * `from` on the way up to `to`. `from` ITSELF IS EXCLUDED (`A..B` is `B --not
 * A`), so a caller asking "which of these commits CONTAIN `from`" must add
 * `from` back for itself.
 *
 * `from` not being an ancestor of `to` is an ANSWER, not an error: the range is
 * empty and git exits 0 — nothing on the way to `to` contains `from`.
 */
export async function ancestryPath(repo: string, from: string, to: string): Promise<string[]> {
  const res = await git(repo, ['rev-list', '--ancestry-path', `${from}..${to}`]);
  return res.stdout.split('\n').filter(Boolean);
}

export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { allowCodes: [1] });
  return res.code === 0;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  subject: string;
}

export async function commitInfo(repo: string, ref: string): Promise<CommitInfo> {
  const res = await git(repo, ['show', '--no-patch', '--format=%H%n%P%n%s', ref]);
  const [sha, parents, subject] = res.stdout.split('\n');
  return { sha, parents: parents ? parents.split(' ').filter(Boolean) : [], subject: subject ?? '' };
}

export interface FileChange {
  status: string; // A / M / D / R100 ...
  path: string;
}

/** Name-status diff between two committishes. */
export async function diffNameStatus(repo: string, from: string, to: string): Promise<FileChange[]> {
  const res = await git(repo, ['diff', '--name-status', '--no-renames', from, to]);
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest[rest.length - 1] };
    });
}

/** Diff text between two committishes limited to paths, capped at maxBytes. */
export async function diffText(
  repo: string,
  from: string,
  to: string,
  paths: string[],
  maxBytes: number,
): Promise<string> {
  const args = ['diff', '--no-color', from, to];
  if (paths.length > 0) args.push('--', ...paths);
  const res = await git(repo, args);
  return res.stdout.length > maxBytes ? res.stdout.slice(0, maxBytes) : res.stdout;
}

/**
 * Create a merge commit on a branch that is NOT
 * checked out anywhere, entirely via plumbing (merge-tree + commit-tree +
 * update-ref). Only valid for a CLEAN merge-tree result.
 */
export async function commitTreeMerge(
  repo: string,
  branch: string,
  mergeRef: string,
  message: string,
): Promise<string> {
  const tip = await revParse(repo, branch);
  const theirs = await revParse(repo, mergeRef);
  const mt = await newStyleMergeTree(repo, branch, mergeRef);
  if (!mt.clean) {
    throw new Error(
      `commitTreeMerge: ${branch} <- ${mergeRef} is not a clean merge (${mt.conflictFiles.length} conflicts)`,
    );
  }
  const commit = (await git(repo, ['commit-tree', mt.treeOid, '-p', tip, '-p', theirs, '-m', message])).stdout.trim();
  // Compare-and-swap: fails loudly if the branch moved underneath us.
  await git(repo, ['update-ref', `refs/heads/${branch}`, commit, tip]);
  return commit;
}

/**
 * Driver push (DRIVER.md §2.5): move a ref on origin via `git push` — the
 * ONLY way refs move to the remote (the API is never used to fabricate
 * refs/commits as a push workaround). `src` is a committish (branch name or
 * sha); `dstBranch` the remote branch name. Never force — with ONE
 * compare-and-swap exception: a reissue republish replaces the prior
 * resolution head on the fix/sweep ref (non-fast-forward by construction), so
 * the caller passes the EXPECTED old sha as `forceWithLease` and the push
 * succeeds only if the remote ref is still exactly there (no blind force,
 * ever). Throws GitError on failure — callers journal the halt and surface
 * ERR15_PUSH_FAILED (an owner report per DRIVER.md §10.3, no fallback of
 * any kind).
 */
export async function gitPush(
  repo: string,
  src: string,
  dstBranch: string,
  opts: { forceWithLease?: string } = {},
): Promise<void> {
  const args = [...pushCredentialArgs(), 'push'];
  if (opts.forceWithLease) args.push(`--force-with-lease=refs/heads/${dstBranch}:${opts.forceWithLease}`);
  args.push('origin', `${src}:refs/heads/${dstBranch}`);
  await git(repo, args, { env: { GIT_TERMINAL_PROMPT: '0' } });
}

/** Delete a remote ref — a push, so it needs the same credentials. */
export async function gitPushDelete(repo: string, ref: string): Promise<void> {
  await git(repo, [...pushCredentialArgs(), 'push', 'origin', '--delete', ref], {
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * Credentials for a driver push, supplied per-invocation via `-c`.
 *
 * The clone's origin is plain `https://github.com/...` with no credential
 * helper anywhere — not in the clone, the image, or the container config — so
 * a bare `git push` has nothing to authenticate with and dies on
 * `could not read Username for 'https://github.com'`.
 *
 * The token is the SUBSTITUTE `GH_TOKEN` the credential proxy already swaps on
 * the wire for this driver's API calls; a push is the same path (HTTPS_PROXY is
 * set in the container), so it needs no special handling here.
 *
 * Passed with `-c` rather than written to config: nothing persists in
 * `.git/config` for a later reader to find, and the helper reads the variable at
 * call time instead of baking a value in. The empty helper first RESETS the
 * chain, so a stale helper configured elsewhere cannot take precedence. With
 * `GIT_TERMINAL_PROMPT=0` a missing token fails immediately and legibly instead
 * of blocking on a prompt no one can answer.
 */
function pushCredentialArgs(): string[] {
  return [
    '-c',
    'credential.helper=',
    '-c',
    'credential.helper=!f() { echo username=x-access-token; echo "password=${GH_TOKEN:-$GITHUB_TOKEN}"; }; f',
  ];
}

/** Reset a branch ref (rollback) with compare-and-swap on the expected current value. */
export async function resetBranchRef(
  repo: string,
  branch: string,
  to: string,
  expectedCurrent?: string,
): Promise<void> {
  const args = ['update-ref', `refs/heads/${branch}`, to];
  if (expectedCurrent) args.push(expectedCurrent);
  await git(repo, args);
}

/** Map of branch -> worktree path for branches currently checked out. */
export async function worktreeBranches(repo: string): Promise<Map<string, string>> {
  const res = await git(repo, ['worktree', 'list', '--porcelain']);
  const map = new Map<string, string>();
  let path = '';
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/')) map.set(line.slice('branch refs/heads/'.length), path);
  }
  return map;
}

export interface TempWorktree {
  path: string;
  remove(): Promise<void>;
}

/** Add a temporary worktree (detached unless a branch name is given). */
export async function addTempWorktree(
  repo: string,
  ref: string,
  opts: { branch?: string } = {},
): Promise<TempWorktree> {
  const path = mkdtempSync(join(tmpdir(), 'sweep-wt-'));
  const args = ['worktree', 'add'];
  if (opts.branch) args.push(path, opts.branch);
  else args.push('--detach', path, ref);
  await git(repo, args);
  return {
    path,
    async remove() {
      await git(repo, ['worktree', 'remove', '--force', path], { allowCodes: [128, 1] });
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Absolute path of the shared .git dir (rr-cache lives here). */
export async function gitCommonDir(repo: string): Promise<string> {
  const res = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return res.stdout.trim();
}

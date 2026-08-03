/**
 * scripts/sweep/fixtures.ts — throwaway git fixture repos for sweep tests.
 *
 * Tests NEVER mutate the real fork repo: every mutating stage is exercised
 * against tiny repos built here in os.tmpdir() (an "upstream" branch plus
 * fork branches with synthetic conflicts and PoIs).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Belt-and-braces network isolation (D-059 FINAL review, finding 1): every git
// process a test spawns — the fixture helpers below AND the driver under test
// (git.ts inherits process.env) — runs with terminal prompts off and the
// machine-global/system config masked, so no credential manager, no global
// insteadOf rewrite, and no interactive auth can ever be in a test's path.
// fixtures.ts is imported by every repo-touching test and by nothing else.
process.env.GIT_TERMINAL_PROMPT = '0';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

/** A guaranteed-dead local path: never created, so any git transport pointed at it fails in milliseconds. */
export const DEAD_ORIGIN_PATH = join(tmpdir(), 'sweep-dead-origin');

export class FixtureRepo {
  constructor(public dir: string) {}

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@test.invalid',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@test.invalid',
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  }

  write(path: string, content: string): void {
    const full = join(this.dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  commit(message: string, files: Record<string, string> = {}): string {
    for (const [path, content] of Object.entries(files)) this.write(path, content);
    this.git('add', '-A');
    this.git('commit', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  checkout(branch: string, opts: { create?: boolean; at?: string } = {}): void {
    if (opts.create) this.git('checkout', '-b', branch, opts.at ?? 'HEAD');
    else this.git('checkout', branch);
  }

  sha(ref: string): string {
    return this.git('rev-parse', ref);
  }

  /**
   * A PROPAGATION MERGE onto the currently checked-out branch: the receiving
   * branch becomes the FIRST parent and `branch` the second, which is the whole
   * basis of first-parent authorship (attribute.ts). `--no-ff` so the merge
   * commit always exists — a fast-forward would splice the donated commits
   * straight onto the receiver's own first-parent line and make it look like
   * the author. Returns the merge commit sha.
   */
  merge(branch: string, message = `merge ${branch}`): string {
    this.git('merge', '--no-ff', '--no-edit', '-m', message, branch);
    return this.git('rev-parse', 'HEAD');
  }

  /**
   * Fake an `origin` remote-tracking ref (refs/remotes/origin/<branch>) at
   * `at` (default: the branch itself). Lets tests simulate remote-only /
   * behind / ahead / diverged branch states without a second repo
   * (PROPAGATION.md §13, D-045).
   */
  setOrigin(branch: string, at?: string): string {
    const sha = this.sha(at ?? branch);
    this.git('update-ref', `refs/remotes/origin/${branch}`, sha);
    return sha;
  }

  /** Delete a local branch ref (keeps any refs/remotes/origin/<branch>). */
  deleteLocalBranch(branch: string): void {
    this.git('update-ref', '-d', `refs/heads/${branch}`);
  }

  /**
   * Attach a REAL, pushable `origin` (D-049 push tests): a bare repo on disk,
   * while the configured remote URL stays github-shaped (parseGithubSlug must
   * work) — `url.<bare>.insteadOf` rewrites it for actual git transport, so
   * `git push origin …` really moves refs into the bare repo and updates the
   * local remote-tracking refs. Returns the bare repo dir (cleaned up with the
   * fixture via destroy()).
   */
  attachBareOrigin(url = 'https://github.com/k-fls/fixture.git'): string {
    const bare = mkdtempSync(join(tmpdir(), 'sweep-origin-'));
    this.bareOrigins.push(bare);
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
    this.git('remote', 'add', 'origin', url);
    this.git('config', `url.${bare}.insteadOf`, url);
    return bare;
  }

  /**
   * Break the origin TRANSPORT deterministically (D-059 FINAL finding 1):
   * repoint the `url.<…>.insteadOf` rewrite from the bare repo to a DEAD LOCAL
   * path, so `git push origin …` fails locally in ~10ms with a repository-not-
   * found error (categorized `transient`). NEVER merely unset the rewrite —
   * that sends the push to the real github.com (a ~3s network round-trip that
   * flakes the 5s test timeout, and a live push hazard).
   */
  breakOriginTransport(bare: string, url = 'https://github.com/k-fls/fixture.git'): void {
    this.git('config', '--unset', `url.${bare}.insteadOf`);
    this.git('config', `url.${DEAD_ORIGIN_PATH}.insteadOf`, url);
  }

  /** Undo breakOriginTransport: drop the dead mapping, restore the bare-repo rewrite. */
  healOriginTransport(bare: string, url = 'https://github.com/k-fls/fixture.git'): void {
    this.git('config', '--unset', `url.${DEAD_ORIGIN_PATH}.insteadOf`);
    this.git('config', `url.${bare}.insteadOf`, url);
  }

  private bareOrigins: string[] = [];

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
    for (const b of this.bareOrigins) rmSync(b, { recursive: true, force: true });
  }
}

/** Bare-bones repo: `main` with a couple of base files. */
export function initFixtureRepo(): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-fixture-'));
  const repo = new FixtureRepo(dir);
  repo.git('init', '-b', 'main');
  repo.git('config', 'user.name', 'fixture');
  repo.git('config', 'user.email', 'fixture@test.invalid');
  repo.git('config', 'commit.gpgsign', 'false');
  repo.commit('base', {
    'README.md': 'base\n',
    'src/app.ts': 'export const app = () => 1;\nexport const shared = "original";\n',
    'package.json': '{"name":"fixture","version":"1.0.0"}\n',
  });
  return repo;
}

/**
 * Standard sweep fixture:
 *   main            base
 *   upstream-main   base + U1(clean) + U2(clean) + U3(conflicts with fork) + U4(clean)
 *   feat/one        base + same-line edit of src/app.ts  (conflicts from U3 on)
 *   feat/two        base + independent file              (always merges clean)
 */
export function makeSweepFixture(): {
  repo: FixtureRepo;
  upstream: string;
  chain: string[]; // U1..U4 shas, oldest first
} {
  const repo = initFixtureRepo();

  repo.checkout('feat/one', { create: true, at: 'main' });
  repo.commit('feat one: change shared line', {
    'src/app.ts': 'export const app = () => 1;\nexport const shared = "fork-one";\n',
  });

  repo.checkout('main');
  repo.checkout('feat/two', { create: true, at: 'main' });
  repo.commit('feat two: independent file', { 'src/two.ts': 'export const two = 2;\n' });

  repo.checkout('main');
  repo.checkout('upstream-main', { create: true, at: 'main' });
  const chain: string[] = [];
  chain.push(repo.commit('U1: docs', { 'docs/notes.md': 'notes\n' }));
  chain.push(repo.commit('U2: add util', { 'src/util.ts': 'export const util = true;\n' }));
  chain.push(
    repo.commit('U3: change shared line', {
      'src/app.ts': 'export const app = () => 1;\nexport const shared = "upstream";\n',
    }),
  );
  chain.push(repo.commit('U4: more docs', { 'docs/more.md': 'more\n' }));
  repo.checkout('main');
  return { repo, upstream: 'upstream-main', chain };
}

/**
 * Propagation fixture with a NON-MONOTONIC conflict window (PROPAGATION.md §3):
 *
 *   main / base       src/x.ts = "orig"
 *   fork              src/x.ts = "fork"                       (cut from base)
 *   upstream-main     U0 add util (clean)         height 0
 *                     U1 x = "up1" (conflicts fork)  height 1
 *                     U2 x = "fork" (== fork, clean)  height 2
 *                     U3 x = "up3" (conflicts fork)  height 3
 *
 * Merging `fork` up to height 0 or 2 is clean; heights 1 and 3 conflict. The
 * linear sweep must merge at the LARGEST clean height (2, past the height-1
 * conflict) and report height 3 as the case.
 */
export function makePropagationFixture(): {
  repo: FixtureRepo;
  base: string;
  upstream: string;
  chain: string[]; // U0..U3, oldest first (heights 0..3)
} {
  const repo = initFixtureRepo();
  repo.commit('base: x = orig', { 'src/x.ts': 'orig\n' });
  const base = repo.sha('main');

  repo.checkout('fork', { create: true, at: 'main' });
  repo.commit('fork: x = fork', { 'src/x.ts': 'fork\n' });

  repo.checkout('main');
  repo.checkout('upstream-main', { create: true, at: 'main' });
  const chain: string[] = [];
  chain.push(repo.commit('U0: add util', { 'src/util.ts': 'export const u = 1;\n' }));
  chain.push(repo.commit('U1: x = up1', { 'src/x.ts': 'up1\n' }));
  chain.push(repo.commit('U2: x = fork', { 'src/x.ts': 'fork\n' }));
  chain.push(repo.commit('U3: x = up3', { 'src/x.ts': 'up3\n' }));
  repo.checkout('main');
  return { repo, base, upstream: 'upstream-main', chain };
}

/**
 * THE 2026-08-01 INCIDENT, as a repo (pass `87175bdb89ad`, case
 * `main_patched--main-h174`). Everything a sweep needs to walk straight into the
 * deadlock `--not-my-bug` exists for, with real commits and REAL check commands:
 *
 *   main            base  groups.ts = "base", poll-loop.test.ts GREEN
 *                   U1    groups.ts = "upstream"        <- theirs, conflicts
 *
 *   main_patched    P1    groups.ts = "fork"            <- ours, the conflict
 *                   P2    unrelated
 *                   P3    poll-loop.test.ts -> BROKEN   <- THE INTRODUCER
 *                   P4    unrelated
 *                   P5    unrelated                        (branch tip)
 *
 * So the case's conflict is `src/cli/resources/groups.ts`, while the checks fail
 * on `container/agent-runner/src/poll-loop.test.ts` — a file the case never
 * touches, already red on the branch three commits before the tip, exactly as
 * upstream `3d4b349b` left it live. A bisect over `main_patched` has a genuine
 * green anchor (P1/P2) and one right answer (P3).
 *
 * The checks are real programs, not a stubbed `ChecksRunner`: `run-tests.sh`
 * prints BUN-SHAPED output (a `<file>:` header, then `(fail)` lines under it),
 * because parsing that shape is itself part of what broke — a bun failure named
 * no file at all, so blame fell to the trunk and there was nothing to compare.
 * The test file is the ONLY input, so any tree can be probed and the answer is
 * a property of that tree.
 */
export function makeNotMyBugIncidentFixture(): {
  repo: FixtureRepo;
  /** The commit that broke the test — what the bisect must name. */
  introducer: string;
  /** Path of the failing test, repo-rooted (as the driver sees it). */
  failingTest: string;
  /** Path of the conflicted file. */
  conflictedPath: string;
} {
  const failingTest = 'container/agent-runner/src/poll-loop.test.ts';
  const conflictedPath = 'src/cli/resources/groups.ts';
  // Ignores any file arguments: the filtered form (`… {files}`) and the whole
  // form must answer identically, so a narrowed probe and a full run agree.
  const runTests = [
    '#!/bin/sh',
    'echo "src/poll-loop.test.ts:"',
    'if grep -q BROKEN src/poll-loop.test.ts 2>/dev/null; then',
    '  echo "(fail) task-run turn wiring (real processQuery) > logs and conditionally nudges a second task run [5000.64ms]"',
    '  echo "  ^ this test timed out after 5000ms."',
    '  echo " 1 fail"',
    '  exit 1',
    'fi',
    'echo " 1 pass"',
    'exit 0',
    '',
  ].join('\n');

  const dir = mkdtempSync(join(tmpdir(), 'sweep-incident-'));
  const repo = new FixtureRepo(dir);
  repo.git('init', '-b', 'main');
  repo.git('config', 'user.name', 'fixture');
  repo.git('config', 'user.email', 'fixture@test.invalid');
  repo.git('config', 'commit.gpgsign', 'false');
  repo.commit('base', {
    'package.json': '{"name":"fixture","version":"1.0.0"}\n',
    'container/agent-runner/package.json': '{"name":"agent-runner","version":"1.0.0"}\n',
    'tools/typecheck.sh': '#!/bin/sh\nexit 0\n',
    'container/agent-runner/run-tests.sh': runTests,
    [failingTest]: 'test("task-run turn wiring", () => ok);\n',
    [conflictedPath]: 'export const createGroup = () => "base";\n',
  });

  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('fix(ncl): groups create now provisions container_configs', {
    [conflictedPath]: 'export const createGroup = () => "fork";\n',
  });
  repo.commit('chore: unrelated', { 'docs/a.md': 'a\n' });
  const introducer = repo.commit('test(tasks): cover one-door task turns', {
    [failingTest]: 'test("task-run turn wiring", () => BROKEN);\n',
  });
  repo.commit('chore: unrelated two', { 'docs/b.md': 'b\n' });
  repo.commit('chore: unrelated three', { 'docs/c.md': 'c\n' });

  repo.checkout('main');
  repo.commit('feat: support scheduled tasks in templates', {
    [conflictedPath]: 'export const createGroup = () => "upstream";\n',
  });
  repo.checkout('main_patched');
  return { repo, introducer, failingTest, conflictedPath };
}

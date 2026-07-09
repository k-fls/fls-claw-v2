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

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true });
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

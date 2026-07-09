import { describe, expect, it } from 'vitest';

import { globFilter, globMatch, globMatchAny } from './globs.js';

describe('globMatch', () => {
  it('matches literals exactly', () => {
    expect(globMatch('src/config.ts', 'src/config.ts')).toBe(true);
    expect(globMatch('src/config.ts', 'src/config.ts.bak')).toBe(false);
    expect(globMatch('src/config.ts', 'other/src/config.ts')).toBe(false);
  });

  it('* stays within a path segment', () => {
    expect(globMatch('src/*.ts', 'src/app.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/deep/app.ts')).toBe(false);
    expect(globMatch('*.md', 'README.md')).toBe(true);
    expect(globMatch('*.md', 'docs/README.md')).toBe(false);
  });

  it('** spans directories', () => {
    expect(globMatch('src/modules/example/**', 'src/modules/example/index.ts')).toBe(true);
    expect(globMatch('src/modules/example/**', 'src/modules/example/deep/nested.ts')).toBe(true);
    expect(globMatch('src/modules/example/**', 'src/modules/other/index.ts')).toBe(false);
    expect(globMatch('**/package.json', 'container/agent-runner/package.json')).toBe(true);
    expect(globMatch('**/package.json', 'package.json')).toBe(true);
    expect(globMatch('**/*credential*', 'src/providers/claude-credential.ts')).toBe(true);
    expect(globMatch('**/*credential*', 'credential-acquisition.ts')).toBe(true);
  });

  it('? matches one non-separator character', () => {
    expect(globMatch('file?.ts', 'file1.ts')).toBe(true);
    expect(globMatch('file?.ts', 'file12.ts')).toBe(false);
    expect(globMatch('file?.ts', 'file/.ts')).toBe(false);
  });

  it('{a,b} alternation', () => {
    expect(globMatch('src/poll-loop.{ts,test.ts}', 'src/poll-loop.ts')).toBe(true);
    expect(globMatch('src/poll-loop.{ts,test.ts}', 'src/poll-loop.test.ts')).toBe(true);
    expect(globMatch('src/poll-loop.{ts,test.ts}', 'src/poll-loop.js')).toBe(false);
  });

  it('trailing slash means directory contents', () => {
    expect(globMatch('container/skills/', 'container/skills/foo/SKILL.md')).toBe(true);
    expect(globMatch('container/skills/', 'container/other.ts')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    expect(globMatch('a+b/c.ts', 'a+b/c.ts')).toBe(true);
    expect(globMatch('a+b/c.ts', 'aab/cxts')).toBe(false);
    expect(globMatch('a(1)/[x].ts', 'a(1)/[x].ts')).toBe(true);
  });

  it('branch-name globs used for exclusions', () => {
    expect(globMatch('everything*', 'everything')).toBe(true);
    expect(globMatch('everything*', 'everything-ssh-l3')).toBe(true);
    expect(globMatch('experimental/**', 'experimental/feat/cli-policies')).toBe(true);
    expect(globMatch('worktree-agent-*', 'worktree-agent-a08916d4a38ce8fd7')).toBe(true);
    expect(globMatch('module/**', 'module/host-rpc')).toBe(true);
    expect(globMatch('module/**', 'feat/ssh-auth')).toBe(false);
  });
});

describe('globMatchAny / globFilter', () => {
  it('any-of matching', () => {
    expect(globMatchAny(['*.md', 'src/**'], 'src/x/y.ts')).toBe(true);
    expect(globMatchAny(['*.md', 'src/**'], 'setup/index.ts')).toBe(false);
  });

  it('filters path lists', () => {
    expect(globFilter('src/**', ['src/a.ts', 'docs/b.md', 'src/c/d.ts'])).toEqual(['src/a.ts', 'src/c/d.ts']);
  });
});

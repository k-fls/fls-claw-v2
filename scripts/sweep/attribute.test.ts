/**
 * scripts/sweep/attribute.test.ts — D-061 (B) blame.
 *
 * The live 2026-07-28 failure is the reference case throughout: verify accused
 * `feat/mitm-credential-proxy`, but the type error was in `src/command-gate.ts`,
 * owned by `module/command-gate`. A gate-fix rooted on the accused branch would
 * hand the agent files it has no business editing.
 */
import { describe, expect, it } from 'vitest';

import { attributeFailure, branchCandidates, parseFailingFiles } from './attribute.js';
import { assertNoParentInversion, branchHierarchy, depthOf, minPathOf } from './hierarchy.js';
import type { FeatureEntry } from './types.js';

function feat(over: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return {
    name: over.id,
    kind: 'module',
    status: 'shipped',
    ...over,
  } as FeatureEntry;
}

describe('parseFailingFiles', () => {
  it('parses the real tsc bracket form (the 2026-07-28 diagnostic)', () => {
    const out = [
      'src/command-gate.ts(343,45): error TS2345: Argument of type \'string | null | undefined\' is not',
      "  assignable to parameter of type 'string'.",
    ].join('\n');
    expect(parseFailingFiles(out)).toEqual(['src/command-gate.ts']);
  });

  it('parses the tsc colon/pretty form and vitest FAIL lines, de-duped, first-seen order', () => {
    const out = [
      'src/b.ts:12:3 - error TS2322: Type X is not assignable',
      ' FAIL  src/guard/conformance.test.ts [ src/guard/conformance.test.ts ]',
      'src/b.ts(99,1): error TS1005: expected',
    ].join('\n');
    expect(parseFailingFiles(out)).toEqual(['src/b.ts', 'src/guard/conformance.test.ts']);
  });

  it('returns nothing for output with no recognizable diagnostics (=> caller must fall back)', () => {
    expect(parseFailingFiles('ELIFECYCLE Command failed.\nsh: 1: tsc: not found')).toEqual([]);
  });
});

describe('hierarchy — the ONE depth/minPath implementation', () => {
  // Parents are BRANCH names, never entry ids. Keying the DAG by id silently
  // dropped every edge, collapsed all depths to 0, and let a depth-6 edition
  // outrank three depth-2 modules.
  const features = [
    feat({ id: 'cq', branch: 'module/container-queue', parents: ['main_patched'] }),
    feat({ id: 'agc', branch: 'module/agent-group-contributions', parents: ['main_patched'] }),
    feat({ id: 'ih', branch: 'module/interactions-helpers', parents: ['module/agent-group-contributions'] }),
    feat({ id: 'creds', branch: 'module/credentials', parents: ['module/interactions-helpers'] }),
    feat({
      id: 'mitm',
      branch: 'feat/mitm-credential-proxy',
      parents: ['module/container-queue', 'module/credentials', 'module/agent-group-contributions'],
    }),
    feat({ id: 'edition', branch: 'edition/fls-ai-bot', parents: ['feat/mitm-credential-proxy'] }),
  ];
  const h = branchHierarchy(features);

  it('main=0, main_patched=1, and depth is 1 + MAX(parents) — never MIN', () => {
    expect(depthOf(h, 'main')).toBe(0);
    expect(depthOf(h, 'main_patched')).toBe(1);
    expect(depthOf(h, 'module/agent-group-contributions')).toBe(2);
    expect(depthOf(h, 'module/interactions-helpers')).toBe(3);
    expect(depthOf(h, 'module/credentials')).toBe(4);
    // mitm's shallowest parent is at 2, its DEEPEST is credentials at 4.
    // MIN would say 3 — level with its own parent module/credentials. MAX says 5.
    expect(depthOf(h, 'feat/mitm-credential-proxy')).toBe(5);
    expect(depthOf(h, 'edition/fls-ai-bot')).toBe(6);
  });

  it('INVARIANT: no branch sits at or above the depth of any parent', () => {
    expect(assertNoParentInversion(h)).toEqual([]);
  });

  it('minPath is the SHORTEST chain to main, excluding main — distinct from depth', () => {
    expect(minPathOf(h, 'main_patched')).toEqual([]);
    expect(minPathOf(h, 'module/agent-group-contributions')).toEqual(['main_patched']);
    expect(minPathOf(h, 'module/credentials')).toEqual([
      'module/interactions-helpers',
      'module/agent-group-contributions',
      'main_patched',
    ]);
    // depth 5 (via the deepest parent) but only 2 hops on the shortest route.
    expect(depthOf(h, 'feat/mitm-credential-proxy')).toBe(5);
    expect(minPathOf(h, 'feat/mitm-credential-proxy')).toEqual(['module/container-queue', 'main_patched']);
  });

  it('a branch with no route to a root is UNRESOLVED (null), never depth 0', () => {
    const orphaned = branchHierarchy([feat({ id: 'o', branch: 'feat/orphan', parents: ['feat/ghost'] })]);
    expect(depthOf(orphaned, 'feat/orphan')).toBeNull();
    expect(minPathOf(orphaned, 'feat/orphan')).toBeNull();
    expect(orphaned.unresolved).toEqual(['feat/orphan']);
  });

  it('a parents CYCLE terminates instead of hanging the driver', () => {
    const cyclic = branchHierarchy([
      feat({ id: 'a', branch: 'feat/a', parents: ['feat/b'] }),
      feat({ id: 'b', branch: 'feat/b', parents: ['feat/a'] }),
    ]);
    expect(depthOf(cyclic, 'feat/a')).toBeNull();
  });
});

describe('branchCandidates — the OWNER RULE (earliest by hierarchy)', () => {
  // parents are BRANCH names (as the live inventory writes them), not entry ids.
  const features = [
    feat({ id: 'trunk', branch: 'main_patched', owned_paths: ['src/**'] }),
    feat({ id: 'cg', branch: 'module/command-gate', parents: ['main_patched'], owned_paths: ['src/command-gate.ts'] }),
    feat({
      id: 'proxy',
      branch: 'feat/mitm-credential-proxy',
      parents: ['module/command-gate'],
      touch_paths: ['src/command-gate.ts'],
    }),
  ];

  it('several branches implicated -> shallowest hierarchy depth first, TRUNK included', () => {
    const c = branchCandidates(['src/command-gate.ts'], features);
    expect(c.map((x) => x.branch)).toEqual(['main_patched', 'module/command-gate', 'feat/mitm-credential-proxy']);
    expect(c.map((x) => x.depth)).toEqual([1, 2, 3]); // main=0; the trunk is 1
  });

  it('at EQUAL depth, an owner beats a toucher', () => {
    const tie = [
      feat({ id: 'root' }),
      feat({ id: 'toucher', branch: 'feat/t', parents: ['root'], touch_paths: ['src/x.ts'] }),
      feat({ id: 'owner', branch: 'feat/o', parents: ['root'], owned_paths: ['src/x.ts'] }),
    ];
    const c = branchCandidates(['src/x.ts'], tie);
    expect(c[0].branch).toBe('feat/o');
    expect(c[0].match).toBe('owned');
  });

  it('GLOB semantics: `dir/**` matches beneath — and so does a bare DIRECTORY', () => {
    // The live inventory is 23 globs + 220 exact file paths, so glob semantics
    // is the contract — the old literal-prefix behaviour matched none of them.
    const g = [feat({ id: 'm', branch: 'b', parents: ['main_patched'], owned_paths: ['src/modules/typing/**'] })];
    expect(branchCandidates(['src/modules/typing/index.ts'], g)).toHaveLength(1);
    expect(branchCandidates(['src/modules/typing-extra/x.ts'], g)).toHaveLength(0);
    // A bare DIRECTORY owns what is inside it (globs.ts's own `dir/` rule, which
    // the registry writes without the trailing slash). `container/agent-runner`
    // is how a whole sub-package is claimed and the shipped checks.json runs
    // that package's suite from inside it; under matches-only-itself every
    // diagnostic that command printed found no owner at all.
    const exact = [feat({ id: 'm', branch: 'b', parents: ['main_patched'], owned_paths: ['src/modules/typing'] })];
    expect(branchCandidates(['src/modules/typing'], exact)).toHaveLength(1);
    expect(branchCandidates(['src/modules/typing/index.ts'], exact)).toHaveLength(1);
    // …but a SIBLING sharing the name prefix is not beneath it.
    expect(branchCandidates(['src/modules/typing-extra/x.ts'], exact)).toHaveLength(0);
  });

  it('entries without a branch are skipped', () => {
    expect(branchCandidates(['src/x.ts'], [feat({ id: 'nobranch', owned_paths: ['src/x.ts'] })])).toEqual([]);
  });
});

describe('attributeFailure — the 2026-07-28 reference case', () => {
  const features = [
    feat({ id: 'cg', branch: 'module/command-gate', parents: ['main_patched'], owned_paths: ['src/command-gate.ts'] }),
    feat({
      id: 'proxy',
      branch: 'feat/mitm-credential-proxy',
      parents: ['module/command-gate'],
      touch_paths: ['src/command-gate.ts'],
    }),
  ];
  const tscOutput =
    "src/command-gate.ts(343,45): error TS2345: Argument of type 'string | null | undefined' is not assignable to parameter of type 'string'.";

  it('roots the fix on the OWNING branch, not the branch verify accused', () => {
    const a = attributeFailure(tscOutput, features, 'feat/mitm-credential-proxy');
    expect(a.branch).toBe('module/command-gate'); // NOT the accused leaf
    expect(a.files).toEqual(['src/command-gate.ts']);
    expect(a.reason).toContain('earliest by hierarchy');
  });

  it('unparseable output -> falls back to the accused branch and SAYS so', () => {
    const a = attributeFailure('sh: 1: tsc: not found', features, 'feat/mitm-credential-proxy');
    expect(a.branch).toBe('feat/mitm-credential-proxy');
    expect(a.reason).toContain('no file paths');
  });

  it('files nobody owns -> falls back to the accused branch and SAYS so', () => {
    const a = attributeFailure('src/unknown/thing.ts(1,1): error TS1005: expected', features, 'feat/x');
    expect(a.branch).toBe('feat/x');
    expect(a.reason).toContain('no registry entry');
  });

  it('no accused branch and nothing attributable -> null, never a guess', () => {
    expect(attributeFailure('garbage', features, null).branch).toBeNull();
  });
});

/**
 * DEFECT 5 (MED) — `pathMatches()` in attribute.ts compares owned_paths /
 * touch_paths as LITERAL prefixes (`file === p || file.startsWith(p + '/')`),
 * but those registry fields are gitignore-style GLOBS: the rest of the driver
 * already matches them with `globMatchAny` from ./globs.ts (routing.ts,
 * validate.ts). Every real inventory pattern ends in `/**` — e.g.
 * `scripts/sweep/**`, `src/modules/ssh-auth/**` — and none of them can ever
 * match a file under literal-prefix semantics, so blame silently finds NO
 * owner and the gate fix falls back to the accused branch (or is refused).
 *
 * CORRECT BEHAVIOUR: attribution matches owned_paths/touch_paths with GLOB
 * semantics, via the existing globs.ts helper.
 */
describe('attributeFailure — owned_paths are GLOBS, not literal prefixes (defect 5)', () => {
  const globFeatures = [
    feat({ id: 'sweep', branch: 'module/sweep', owned_paths: ['scripts/sweep/**'] }),
    feat({ id: 'ssh', branch: 'module/ssh-auth', touch_paths: ['src/modules/ssh-auth/**'] }),
  ];

  it('a `**` owned_paths glob matches the failing file (today: never matches)', () => {
    const a = attributeFailure(
      'scripts/sweep/propagate.ts(3550,9): error TS2345: nope',
      globFeatures,
      'feat/accused',
    );
    expect(a.branch).toBe('module/sweep'); // NOT the accused fallback
    expect(a.candidates.map((c) => c.branch)).toEqual(['module/sweep']);
  });

  it('a `**` touch_paths glob matches too', () => {
    const a = attributeFailure(
      'src/modules/ssh-auth/keys.ts(12,3): error TS2322: nope',
      globFeatures,
      'feat/accused',
    );
    expect(a.branch).toBe('module/ssh-auth');
  });

  it('a `*` segment wildcard matches within one path segment', () => {
    const f = [feat({ id: 'tests', branch: 'module/tests', owned_paths: ['src/*.test.ts'] })];
    expect(attributeFailure('src/guard.test.ts(1,1): error TS1005: expected', f, 'feat/accused').branch).toBe(
      'module/tests',
    );
    // …and a glob must not over-match: a nested file is NOT `src/*.test.ts`.
    expect(attributeFailure('src/deep/guard.test.ts(1,1): error TS1005: expected', f, 'feat/accused').branch).toBe(
      'feat/accused',
    );
  });
});

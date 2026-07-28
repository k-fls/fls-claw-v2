/**
 * scripts/sweep/attribute.test.ts — D-061 (B) blame.
 *
 * The live 2026-07-28 failure is the reference case throughout: verify accused
 * `feat/mitm-credential-proxy`, but the type error was in `src/command-gate.ts`,
 * owned by `module/command-gate`. A gate-fix rooted on the accused branch would
 * hand the agent files it has no business editing.
 */
import { describe, expect, it } from 'vitest';

import { attributeFailure, branchCandidates, hierarchyDepth, parseFailingFiles } from './attribute.js';
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

describe('hierarchyDepth', () => {
  const features = [
    feat({ id: 'trunk' }),
    feat({ id: 'mid', parents: ['trunk'] }),
    feat({ id: 'leaf', parents: ['mid'] }),
    feat({ id: 'shortcut', parents: ['trunk', 'leaf'] }), // shortest route wins
  ];

  it('roots are 0 and depth follows the shortest route to a root', () => {
    expect(hierarchyDepth(features, 'trunk')).toBe(0);
    expect(hierarchyDepth(features, 'mid')).toBe(1);
    expect(hierarchyDepth(features, 'leaf')).toBe(2);
    expect(hierarchyDepth(features, 'shortcut')).toBe(1); // via trunk, not via leaf
  });

  it('a parents CYCLE terminates instead of hanging the driver', () => {
    const cyclic = [feat({ id: 'a', parents: ['b'] }), feat({ id: 'b', parents: ['a'] })];
    expect(hierarchyDepth(cyclic, 'a')).toBeGreaterThanOrEqual(0);
  });

  it('an unknown parent id is ignored rather than throwing', () => {
    expect(hierarchyDepth([feat({ id: 'x', parents: ['ghost'] })], 'x')).toBe(0);
  });
});

describe('branchCandidates — the OWNER RULE (earliest by hierarchy)', () => {
  const features = [
    feat({ id: 'trunk', branch: 'main_patched', owned_paths: ['src/'] }),
    feat({ id: 'cg', branch: 'module/command-gate', parents: ['trunk'], owned_paths: ['src/command-gate.ts'] }),
    feat({ id: 'proxy', branch: 'feat/mitm-credential-proxy', parents: ['cg'], touch_paths: ['src/command-gate.ts'] }),
  ];

  it('several branches implicated -> shallowest hierarchy depth first', () => {
    const c = branchCandidates(['src/command-gate.ts'], features);
    expect(c.map((x) => x.branch)).toEqual(['main_patched', 'module/command-gate', 'feat/mitm-credential-proxy']);
    expect(c.map((x) => x.depth)).toEqual([0, 1, 2]);
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

  it('a directory pattern matches files beneath it, but not a sibling with the same prefix', () => {
    const f = [feat({ id: 'm', branch: 'b', owned_paths: ['src/modules/typing'] })];
    expect(branchCandidates(['src/modules/typing/index.ts'], f)).toHaveLength(1);
    expect(branchCandidates(['src/modules/typing-extra/x.ts'], f)).toHaveLength(0);
  });

  it('entries without a branch are skipped', () => {
    expect(branchCandidates(['src/x.ts'], [feat({ id: 'nobranch', owned_paths: ['src/x.ts'] })])).toEqual([]);
  });
});

describe('attributeFailure — the 2026-07-28 reference case', () => {
  const features = [
    feat({ id: 'cg', branch: 'module/command-gate', owned_paths: ['src/command-gate.ts'] }),
    feat({ id: 'proxy', branch: 'feat/mitm-credential-proxy', parents: ['cg'], touch_paths: ['src/command-gate.ts'] }),
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

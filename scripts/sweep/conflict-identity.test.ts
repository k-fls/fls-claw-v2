import { describe, expect, it } from 'vitest';

import {
  classifyConflict,
  conflictIdentity,
  extractHunks,
  fileHunks,
  identityKeys,
  type ConflictHunk,
} from './conflict-identity.js';

const hunk = (ours: string, theirs: string, ourLabel = 'HEAD', theirLabel = 'abc123'): string =>
  [`<<<<<<< ${ourLabel}`, ours, '=======', theirs, `>>>>>>> ${theirLabel}`].join('\n');

const diff3Hunk = (ours: string, base: string, theirs: string, ourLabel = 'HEAD', theirLabel = 'abc123'): string =>
  [`<<<<<<< ${ourLabel}`, ours, `||||||| ${ourLabel}~1`, base, '=======', theirs, `>>>>>>> ${theirLabel}`].join('\n');

describe('extractHunks — what is kept and what is normalised away', () => {
  it('keeps the bodies verbatim and reduces every label line to its marker', () => {
    // The labels are the side identifiers merge-tree was invoked with, so a
    // base that moved renames all three in a byte-identical conflict.
    const text = ['top', diff3Hunk('ours line', 'base line', 'theirs line'), 'bottom'].join('\n');
    expect(extractHunks(text)).toEqual([
      ['<<<<<<<', 'ours line', '|||||||', 'base line', '=======', 'theirs line', '>>>>>>>'].join('\n'),
    ]);
  });

  it('all three label forms normalise, so a relabelled conflict hashes the same', () => {
    const a = fileHunks('src/x.ts', diff3Hunk('o', 'b', 't', 'main_patched', 'aaaaaaa'));
    const bb = fileHunks('src/x.ts', diff3Hunk('o', 'b', 't', 'feat/other', 'fffffff'));
    expect(a).toEqual(bb);
  });

  it('position in the file is not part of the identity', () => {
    const near = fileHunks('src/x.ts', ['a', hunk('o', 't')].join('\n'));
    const far = fileHunks('src/x.ts', ['a', 'b', 'c', 'd', 'e', hunk('o', 't'), 'z'].join('\n'));
    expect(near).toEqual(far);
  });

  it('whitespace inside the bodies is content, not noise', () => {
    // A re-indent of the disputed region is a different resolution question.
    const flat = fileHunks('src/x.ts', hunk('call(a)', 'call(b)'));
    const indented = fileHunks('src/x.ts', hunk('  call(a)', 'call(b)'));
    expect(flat[0].hash).not.toBe(indented[0].hash);
  });

  it('the ours/base/theirs split matters — swapping the sides is a different conflict', () => {
    const forward = fileHunks('src/x.ts', hunk('o', 't'));
    const reversed = fileHunks('src/x.ts', hunk('t', 'o'));
    expect(forward[0].hash).not.toBe(reversed[0].hash);
  });

  it('a diff3 base section is part of the conflict', () => {
    const withBase = fileHunks('src/x.ts', diff3Hunk('o', 'b', 't'));
    const withoutBase = fileHunks('src/x.ts', hunk('o', 't'));
    expect(withBase[0].hash).not.toBe(withoutBase[0].hash);
  });

  it('several hunks in one file are several entries', () => {
    const text = [hunk('o1', 't1'), 'clean', hunk('o2', 't2')].join('\n');
    expect(extractHunks(text)).toHaveLength(2);
  });

  it('a file with no markers contributes nothing', () => {
    expect(extractHunks('just\nsome\nlines\n')).toEqual([]);
  });

  it('a truncated hunk is kept rather than read as the absence of a conflict', () => {
    // Dropping it would classify a damaged exhibit as healed, which deletes
    // the ref and closes the PR on evidence nobody has.
    const text = ['<<<<<<< HEAD', 'ours line', '=======', 'theirs line'].join('\n');
    expect(extractHunks(text)).toHaveLength(1);
  });
});

describe('conflictIdentity — reading a set of paths', () => {
  const tree: Record<string, string> = {
    'src/x.ts': hunk('ox', 'tx'),
    'src/y.ts': [hunk('oy1', 'ty1'), hunk('oy2', 'ty2')].join('\nclean\n'),
  };
  const read = async (p: string): Promise<string | null> => tree[p] ?? null;

  it('collects every hunk of every path, and an absent path contributes nothing', async () => {
    const id = await conflictIdentity(['src/y.ts', 'src/x.ts', 'src/gone.ts'], read);
    expect(id.map((h) => h.path)).toEqual(['src/x.ts', 'src/y.ts', 'src/y.ts']);
    expect(identityKeys(id).size).toBe(3);
  });

  it('the same hunk text on two paths is two distinct identities', async () => {
    const same = hunk('o', 't');
    const id = await conflictIdentity(['a.ts', 'b.ts'], async (p) => (p === 'a.ts' || p === 'b.ts' ? same : null));
    expect(identityKeys(id).size).toBe(2);
  });
});

describe('classifyConflict — the set relation over two identities', () => {
  const at = (path: string, body: string): ConflictHunk[] => fileHunks(path, hunk(body, `${body}!`));
  const x = at('src/x.ts', 'x');
  const y = at('src/y.ts', 'y');

  it('an empty current set is healed, whatever the baseline was', () => {
    expect(classifyConflict(x, [])).toBe('healed');
    expect(classifyConflict([], [])).toBe('healed');
  });

  it('the same hunks are the same conflict even when the labels moved', () => {
    const relabelled = fileHunks('src/x.ts', hunk('x', 'x!', 'other-branch', 'deadbee'));
    expect(classifyConflict(x, relabelled)).toBe('same');
  });

  it('everything the exhibit asks plus more is a superset', () => {
    expect(classifyConflict(x, [...x, ...y])).toBe('superset');
  });

  it('losing any part of the exhibit makes it a different question', () => {
    expect(classifyConflict([...x, ...y], x)).toBe('different');
    expect(classifyConflict(x, y)).toBe('different');
    // Same path, changed body: the PR's prose describes a conflict that is no
    // longer the one being posed.
    expect(classifyConflict(x, at('src/x.ts', 'x-rewritten'))).toBe('different');
  });

  it('the same conflict moving to another path is a different question', () => {
    const moved = fileHunks('src/moved.ts', hunk('x', 'x!'));
    expect(classifyConflict(x, moved)).toBe('different');
  });
});

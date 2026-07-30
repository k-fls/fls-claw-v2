/**
 * scripts/sweep/cut-points.test.ts — owner-approved cut-point exceptions.
 *
 * The two shapes under test are MEASURED, not invented (live fork 2026-07-29):
 *
 *   DUPLICATE  `3b8c5896` and `dc3cb7f6` are the same patch twice — identical
 *              patch-id `25c7b6481c3a`. `dc3cb7f6` is on module/host-rpc;
 *              `3b8c5896` is on module/credentials, so excluding module/host-rpc
 *              does NOT remove it and blame credits credentials with host-rpc's
 *              work. 23 of 458 non-merge commits (5%) are duplicates.
 *   ABSORBED   module/crypto is an ANCESTOR of main_patched (tip e4c82f34): its
 *              remainder is empty. 5 of the live clone's 25 branches are.
 *
 * The fixture below reproduces the duplicate with a real cherry-pick — two
 * distinct commits with one patch-id — because that is the only way to tell a
 * copy from an original, and the whole exception exists because topology cannot.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { blameCandidates } from './attribute.js';
import {
  loadCutPointExceptions,
  malformedCutPointExceptionsIssue,
  parseCutPointExceptions,
  resolveCutPointExceptions,
  staleWarnings,
  verifyCutPointExceptions,
} from './cut-points.js';
import { type FixtureRepo, initFixtureRepo } from './fixtures.js';
import type { FeatureEntry } from './types.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-cutpoints-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A path in a temp dir that is guaranteed NOT to exist. */
function absentFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-cutpoints-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'cut-point-exceptions.yaml');
}

function feat(over: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return { name: over.id, kind: 'module', status: 'shipped', ...over } as FeatureEntry;
}

const SERVER = 'src/modules/host-rpc/server.ts';

/**
 * THE DUPLICATE, in miniature.
 *
 *   main                 src/shared.ts
 *   main_patched         src/base.ts
 *   module/host-rpc      src/modules/host-rpc/server.ts   <- the ORIGINAL (dc3cb7f6)
 *   module/credentials   <cherry-pick of the above>       <- the COPY (3b8c5896)
 *                        src/credentials.ts               <- its own real work
 *
 * The copy is on module/credentials' OWN first-parent line, so
 * `--first-parent --no-merges module/credentials ^main -- <file>` counts it as
 * credentials' work and `^module/host-rpc` cannot take it away — the original is
 * a DIFFERENT commit. Only patch identity connects them.
 */
interface DupFixture {
  repo: FixtureRepo;
  /** The commit module/host-rpc authored (`dc3cb7f6`). */
  original: string;
  /** The cherry-picked copy on module/credentials (`3b8c5896`). */
  copy: string;
  /** module/credentials' OWN work — a different patch entirely. */
  ownWork: string;
  patchId: string;
}

function duplicateRepo(): DupFixture {
  const repo = initFixtureRepo();
  cleanups.push(() => repo.destroy());
  repo.commit('upstream: shared', { 'src/shared.ts': 'up\n' });
  repo.checkout('main_patched', { create: true, at: 'main' });
  repo.commit('mp: fork base', { 'src/base.ts': 'base\n' });
  repo.checkout('module/host-rpc', { create: true, at: 'main_patched' });
  const original = repo.commit('feat(host-rpc): host HTTP RPC endpoint substrate', {
    [SERVER]: 'server\n',
  });
  // credentials commits its OWN work FIRST, so the cherry-pick lands on a
  // different parent and is a genuinely different COMMIT. (Cherry-picking onto
  // an identical parent reproduces the original object byte for byte — same
  // sha, no duplicate to test.)
  repo.checkout('module/credentials', { create: true, at: 'main_patched' });
  const ownWork = repo.commit('feat(credentials): credential substrate', { 'src/credentials.ts': 'creds\n' });
  repo.git('cherry-pick', original);
  const copy = repo.sha('HEAD');
  repo.checkout('main');
  const patchId = patchIdOf(repo, original);
  expect(copy).not.toBe(original); // two commits …
  expect(patchIdOf(repo, copy)).toBe(patchId); // … one patch
  return { repo, original, copy, ownWork, patchId };
}

/** The implementation's two-step (`git show` -> `git patch-id --stable`), shell-free. */
function patchIdOf(repo: FixtureRepo, sha: string): string {
  const show = execFileSync('git', ['-C', repo.dir, 'show', '--patch', '--no-color', sha], { encoding: 'utf8' });
  const out = execFileSync('git', ['-C', repo.dir, 'patch-id', '--stable'], { input: show, encoding: 'utf8' });
  return out.trim().split(/\s+/)[0];
}

function dupYaml(f: DupFixture, over: Partial<Record<'sha' | 'twin' | 'patch_id', string>> = {}): string {
  return [
    'cut_point_exceptions:',
    '  module/credentials:',
    '    duplicate:',
    `      - sha: ${over.sha ?? f.copy}`,
    `        patch_id: ${over.patch_id ?? f.patchId.slice(0, 12)}`,
    `        twin: ${over.twin ?? f.original}`,
    '        authored_on: module/host-rpc',
    '        why: rebase copy; excluding module/host-rpc does not remove it',
    '',
  ].join('\n');
}

/** The inventory: credentials is SHALLOWER than host-rpc, so the copy decides blame. */
const inventory: FeatureEntry[] = [
  feat({ id: 'creds', branch: 'module/credentials', parents: ['main_patched'] }),
  feat({ id: 'hostrpc', branch: 'module/host-rpc', parents: ['module/credentials'] }),
];

describe('loadCutPointExceptions — ABSENT is silent, MALFORMED is loud (ERR43 precedent)', () => {
  it('ABSENT file: null, no issue — a repo with no exceptions behaves exactly as before', () => {
    const path = absentFile();
    expect(existsSync(path)).toBe(false);
    expect(loadCutPointExceptions(path)).toBeNull();
    expect(malformedCutPointExceptionsIssue(path)).toBeNull();
  });

  it('MALFORMED YAML: null from the loader AND an ERR45 issue — never an indistinguishable skip', () => {
    const path = tmpFile('cut-point-exceptions.yaml', 'cut_point_exceptions:\n  module/credentials:\n   - [oops\n');
    expect(loadCutPointExceptions(path)).toBeNull();
    const issue = malformedCutPointExceptionsIssue(path);
    expect(issue?.id).toBe('ERR45_CUT_POINTS_MALFORMED');
    expect(issue?.detail).toContain(path);
  });

  it('MALFORMED SHAPE: a missing required field is an error, not a quietly dropped entry', () => {
    // `twin` misspelled. Dropping the entry would be indistinguishable from
    // never having written it — the exact silent failure the file exists to avoid.
    const path = tmpFile(
      'cut-point-exceptions.yaml',
      [
        'cut_point_exceptions:',
        '  module/credentials:',
        '    duplicate:',
        '      - sha: 3b8c5896',
        '        patch_id: 25c7b6481c3a',
        '        twln: dc3cb7f6',
        '        authored_on: module/host-rpc',
        '        why: rebase copy',
        '',
      ].join('\n'),
    );
    expect(loadCutPointExceptions(path)).toBeNull();
    expect(malformedCutPointExceptionsIssue(path)?.detail).toContain("missing required string field 'twin'");
  });

  it('MALFORMED SHAPE: branch -> kind -> LIST is enforced (a mapping where a list belongs)', () => {
    const path = tmpFile(
      'cut-point-exceptions.yaml',
      'cut_point_exceptions:\n  module/crypto:\n    absorbed:\n      into: main_patched\n',
    );
    expect(malformedCutPointExceptionsIssue(path)?.detail).toContain("'module/crypto.absorbed' is not a list");
  });

  it('VALID file: both kinds parse, branch -> kind -> LIST, several entries per branch', () => {
    const path = tmpFile(
      'cut-point-exceptions.yaml',
      [
        'cut_point_exceptions:',
        '  module/credentials:',
        '    duplicate:',
        '      - sha: 3b8c5896',
        '        patch_id: 25c7b6481c3a',
        '        twin: dc3cb7f6',
        '        authored_on: module/host-rpc',
        '        why: rebase copy; excluding module/host-rpc does not remove it',
        '      - sha: deadbee1',
        '        patch_id: aaaaaaaaaaaa',
        '        twin: deadbee2',
        '        authored_on: module/egress-lockdown',
        '        why: second copy on the same branch',
        '    absorbed:',
        '      - into: main_patched',
        '        as_of: e4c82f34',
        '        why: two kinds on one branch',
        '  module/crypto:',
        '    absorbed:',
        '      - into: main_patched',
        '        as_of: e4c82f34',
        '        why: parent merged this branch down; remainder is empty',
        '',
      ].join('\n'),
    );
    const ex = loadCutPointExceptions(path)!;
    expect(ex).not.toBeNull();
    expect(ex.count).toBe(4);
    expect(ex.duplicate.get('module/credentials')!.map((d) => d.sha)).toEqual(['3b8c5896', 'deadbee1']);
    expect(ex.duplicate.get('module/credentials')![0].twin).toBe('dc3cb7f6');
    expect(ex.absorbed.get('module/credentials')!.length).toBe(1);
    expect(ex.absorbed.get('module/crypto')![0]).toMatchObject({ into: 'main_patched', as_of: 'e4c82f34' });
    expect(ex.unknownKinds).toEqual([]);
  });

  it('an EMPTY document is an empty file, not a broken one', () => {
    expect(parseCutPointExceptions('# nothing yet\n', 'x').exceptions?.count).toBe(0);
    expect(parseCutPointExceptions('cut_point_exceptions:\n', 'x').exceptions?.count).toBe(0);
  });

  it('an UNKNOWN kind is reported and ignored — new kinds must not need a new file layout', () => {
    const path = tmpFile(
      'cut-point-exceptions.yaml',
      'cut_point_exceptions:\n  module/credentials:\n    reverted:\n      - sha: abc\n',
    );
    expect(malformedCutPointExceptionsIssue(path)).toBeNull();
    expect(loadCutPointExceptions(path)!.unknownKinds).toEqual(['module/credentials.reverted']);
  });
});

describe('verifyCutPointExceptions — re-verified against git, never trusted forever', () => {
  it('DUPLICATE applies only when both patch-ids still match, and it names the FULL sha', async () => {
    const f = duplicateRepo();
    const ex = loadCutPointExceptions(tmpFile('cut-point-exceptions.yaml', dupYaml(f)))!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(staleWarnings(v)).toEqual([]);
    expect([...v.duplicates.get('module/credentials')!]).toEqual([f.copy]);
    expect(v.applied[0]).toContain('is a copy of');
  });

  it('STALE DUPLICATE: the two commits are no longer the same patch — WARN, do NOT apply', async () => {
    const f = duplicateRepo();
    // `twin` points at a commit with a different diff: the claim git used to
    // support is now false. Applying anyway would erase a commit from
    // module/credentials that it really did write — suppressing a real answer.
    const ex = loadCutPointExceptions(tmpFile('cut-point-exceptions.yaml', dupYaml(f, { twin: f.ownWork })))!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(v.duplicates.size).toBe(0);
    expect(staleWarnings(v)).toHaveLength(1);
    expect(staleWarnings(v)[0].detail).toContain('no longer the same patch');
  });

  it('STALE DUPLICATE: the RECORDED patch_id no longer matches the recomputed one — WARN, do NOT apply', async () => {
    const f = duplicateRepo();
    const ex = loadCutPointExceptions(
      tmpFile('cut-point-exceptions.yaml', dupYaml(f, { patch_id: 'ffffffffffff' })),
    )!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(v.duplicates.size).toBe(0);
    expect(staleWarnings(v)[0].detail).toContain('does not match the recomputed');
  });

  it('NOT APPLICABLE (refs absent in this repo) is QUIET — it can suppress nothing', async () => {
    const f = duplicateRepo();
    const ex = loadCutPointExceptions(
      tmpFile('cut-point-exceptions.yaml', dupYaml(f, { sha: '3b8c5896', twin: 'dc3cb7f6' })),
    )!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(v.duplicates.size).toBe(0);
    expect(staleWarnings(v)).toEqual([]);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0].stale).toBe(false);
  });

  it('ABSORBED applies while `as_of` still contains the branch (the module/crypto shape)', async () => {
    const f = duplicateRepo();
    // Absorb module/host-rpc into main_patched, exactly as the trunk absorbs a
    // module branch: the remainder is then empty.
    f.repo.checkout('main_patched');
    f.repo.merge('module/host-rpc', 'verify: merge module/host-rpc');
    const asOf = f.repo.sha('main_patched');
    f.repo.checkout('main');
    const ex = loadCutPointExceptions(
      tmpFile(
        'cut-point-exceptions.yaml',
        [
          'cut_point_exceptions:',
          '  module/host-rpc:',
          '    absorbed:',
          `      - into: main_patched`,
          `        as_of: ${asOf}`,
          '        why: parent merged this branch down; remainder is empty',
          '',
        ].join('\n'),
      ),
    )!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(staleWarnings(v)).toEqual([]);
    expect(v.absorbed.get('module/host-rpc')![0].into).toBe('main_patched');
    expect(v.applied[0]).toContain('has no own commits outside main_patched');
  });

  /**
   * D-062 — a PROPAGATION MERGE on the branch must not falsify `absorbed`.
   *
   * Every pass merges the parent DOWN into each branch. Under the old predicate
   * (`merge-base --is-ancestor <tip> <as_of>`) that advanced the tip past `as_of`,
   * so the entry read STALE from the first merge onward — the exception could only
   * ever hold before the pass did any work, and re-anchoring `as_of` would be
   * falsified again on the very next pass. Live 2026-07-29: module/crypto was
   * flagged STALE at verify while its own remainder was still 0, the sole commit
   * outside main_patched being "Merge main_patched into module/crypto".
   */
  it('D-062 — a propagation merge on the branch does NOT make `absorbed` stale', async () => {
    const f = duplicateRepo();
    f.repo.checkout('main_patched');
    f.repo.merge('module/host-rpc', 'verify: merge module/host-rpc');
    const asOf = f.repo.sha('main_patched');
    // The pass now merges the parent DOWN into the branch — its job, every pass.
    f.repo.checkout('module/host-rpc');
    f.repo.merge('main_patched', 'Merge main_patched into module/host-rpc (propagation)');
    f.repo.checkout('main');
    // The tip has moved past `as_of` ...
    expect(f.repo.sha('module/host-rpc')).not.toBe(asOf);
    // ... but the branch authored nothing new, so it is still absorbed.
    const ex = loadCutPointExceptions(
      tmpFile(
        'cut-point-exceptions.yaml',
        [
          'cut_point_exceptions:',
          '  module/host-rpc:',
          '    absorbed:',
          `      - into: main_patched`,
          `        as_of: ${asOf}`,
          '        why: parent merged this branch down; remainder is empty',
          '',
        ].join('\n'),
      ),
    )!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(staleWarnings(v)).toEqual([]);
    expect(v.absorbed.get('module/host-rpc')![0].into).toBe('main_patched');
  });

  it('STALE ABSORBED: the branch AUTHORED new work outside the parent — WARN, do NOT apply', async () => {
    const f = duplicateRepo();
    f.repo.checkout('main_patched');
    f.repo.merge('module/host-rpc', 'verify: merge module/host-rpc');
    const asOf = f.repo.sha('main_patched');
    // The branch commits again AFTER the absorption: its remainder is no longer
    // empty, so the recorded fact is now false.
    f.repo.checkout('module/host-rpc');
    f.repo.commit('host-rpc: more work', { [SERVER]: 'server v2\n' });
    f.repo.checkout('main');
    const ex = loadCutPointExceptions(
      tmpFile(
        'cut-point-exceptions.yaml',
        [
          'cut_point_exceptions:',
          '  module/host-rpc:',
          '    absorbed:',
          `      - into: main_patched`,
          `        as_of: ${asOf}`,
          '        why: parent merged this branch down; remainder is empty',
          '',
        ].join('\n'),
      ),
    )!;
    const v = await verifyCutPointExceptions(f.repo.dir, ex);
    expect(v.absorbed.size).toBe(0);
    expect(staleWarnings(v)).toHaveLength(1);
    expect(staleWarnings(v)[0].detail).toContain('module/host-rpc has 1 own commit(s) not in main_patched');
  });

  it('a NULL config (absent file) verifies to an empty, warning-free result', async () => {
    const f = duplicateRepo();
    const v = await resolveCutPointExceptions(f.repo.dir, absentFile());
    expect(v.duplicates.size).toBe(0);
    expect(v.absorbed.size).toBe(0);
    expect(v.warnings).toEqual([]);
  });
});

describe('BLAME ignores a listed duplicate — the 3b8c5896 case', () => {
  it('WITHOUT the exception the COPY counts as module/credentials own work (the defect)', async () => {
    const f = duplicateRepo();
    const byFile = await blameCandidates(f.repo.dir, [SERVER], inventory);
    const got = byFile.get(SERVER)!.map((c) => [c.branch, c.commits]);
    // Both branches score 1 — and credentials is the SHALLOWER, so blame picks
    // the branch that only carries a rebase copy of host-rpc's commit.
    expect(got).toEqual([
      ['module/credentials', 1],
      ['module/host-rpc', 1],
    ]);
  });

  it('WITH the exception the copy is not counted and only the true author remains', async () => {
    const f = duplicateRepo();
    const v = await resolveCutPointExceptions(f.repo.dir, tmpFile('cut-point-exceptions.yaml', dupYaml(f)));
    const byFile = await blameCandidates(f.repo.dir, [SERVER], inventory, undefined, v.duplicates);
    expect(byFile.get(SERVER)!.map((c) => [c.branch, c.commits])).toEqual([['module/host-rpc', 1]]);
  });

  it('the exception removes ONLY the listed sha — the branch keeps its own work', async () => {
    const f = duplicateRepo();
    const v = await resolveCutPointExceptions(f.repo.dir, tmpFile('cut-point-exceptions.yaml', dupYaml(f)));
    const byFile = await blameCandidates(f.repo.dir, ['src/credentials.ts'], inventory, undefined, v.duplicates);
    expect(byFile.get('src/credentials.ts')!.map((c) => c.branch)).toEqual(['module/credentials']);
  });

  it('a STALE exception does not suppress the answer — the copy counts again, loudly', async () => {
    const f = duplicateRepo();
    const v = await resolveCutPointExceptions(
      f.repo.dir,
      tmpFile('cut-point-exceptions.yaml', dupYaml(f, { twin: f.ownWork })),
    );
    const byFile = await blameCandidates(f.repo.dir, [SERVER], inventory, undefined, v.duplicates);
    expect(byFile.get(SERVER)!.map((c) => c.branch)).toEqual(['module/credentials', 'module/host-rpc']);
    expect(staleWarnings(v)).toHaveLength(1);
  });
});

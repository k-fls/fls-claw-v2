import { describe, expect, it } from 'vitest';

import { routePois, scorePoi } from './routing.js';
import type { FeatureEntry, Poi, RoutingConfig } from './types.js';

const CFG: RoutingConfig = { weights: { owned: 10, touch: 6, symbol: 3, keyword: 1 }, threshold: 6, top_k: 4 };

function poi(partial: Partial<Poi> & { id: string; type: Poi['type'] }): Poi {
  return { class: 'annotate', paths: [], upstreamCommits: [], commitSubjects: [], branches: [], ...partial };
}

function entry(partial: Partial<FeatureEntry> & { id: string }): FeatureEntry {
  return {
    name: partial.id,
    kind: 'feat',
    status: 'shipped',
    branch: `feat/${partial.id}`,
    ...partial,
  } as FeatureEntry;
}

const MITM = entry({
  id: 'feat.mitm',
  owned_paths: ['src/modules/mitm-proxy/**', 'container/agent-runner/src/auth/**'],
  touch_paths: ['src/container-runner.ts', 'container/Dockerfile'],
  symbol_watch: ['credential|oauth'],
  routing: { keywords: ['proxy'], always_check_on: ['dockerfile-change'] },
});
const AGC = entry({
  id: 'module.agc',
  owned_paths: ['src/agent-group-contributions.ts'],
  touch_paths: ['src/container-runner.ts', 'src/command-gate.ts'],
  routing: { keywords: ['contribution'] },
});
const SKILLS = entry({
  id: 'feat.skills',
  owned_paths: ['container/skills/**'],
  routing: { always_check_on: ['new-skill'] },
});

describe('scorePoi', () => {
  it('weights owned > touch > symbol > keyword', () => {
    const p = poi({
      id: 'p1',
      type: 'generic-diff',
      paths: ['src/modules/mitm-proxy/index.ts', 'src/container-runner.ts'],
      commitSubjects: ['feat: rework proxy wiring'],
      diffText: 'const oauthToken = acquire();',
    });
    const s = scorePoi(p, MITM, CFG);
    expect(s.components).toEqual({ owned: 1, touch: 1, symbol: 1, keyword: 1, forced: false });
    expect(s.score).toBe(10 + 6 + 3 + 1);
  });

  it('symbol_watch also matches new file basenames', () => {
    const p = poi({ id: 'p2', type: 'large-new-file', paths: ['x/y.ts'], newBasenames: ['credential-store.ts'] });
    expect(scorePoi(p, MITM, CFG).components.symbol).toBe(1);
  });

  it('always_check_on forces at least the threshold', () => {
    const skill = poi({ id: 'p3', type: 'new-skill', paths: ['.claude/skills/demo/SKILL.md'] });
    const s = scorePoi(skill, SKILLS, CFG);
    expect(s.components.forced).toBe(true);
    expect(s.score).toBe(CFG.threshold);
    // dockerfile-change is derived from paths, not a scan type.
    const docker = poi({ id: 'p4', type: 'sensitive-surface-touch', paths: ['container/Dockerfile'] });
    expect(scorePoi(docker, MITM, CFG).components.forced).toBe(true);
  });

  it('invalid symbol_watch regex is ignored, not fatal', () => {
    const broken = entry({ id: 'broken', symbol_watch: ['([unclosed'] });
    const p = poi({ id: 'p5', type: 'generic-diff', diffText: 'anything' });
    expect(scorePoi(p, broken, CFG).components.symbol).toBe(0);
  });
});

describe('routePois', () => {
  it('routes above-threshold entries, capped at top_k, and batches per feature', () => {
    const p = poi({ id: 'p1', type: 'generic-diff', paths: ['src/container-runner.ts'] });
    const out = routePois([p], [MITM, AGC, SKILLS], CFG);
    // touch hit (6) reaches threshold for both MITM and AGC; SKILLS scores 0.
    expect(out.routes.map((r) => r.featureId).sort()).toEqual(['feat.mitm', 'module.agc']);
    expect(out.catchAll).toEqual([]);
    expect(out.byFeature['feat.mitm']).toEqual(['p1']);
    expect(out.byFeature['module.agc']).toEqual(['p1']);
  });

  it('caps at top_k highest scores', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map((n, i) =>
      entry({ id: `feat.${n}`, owned_paths: ['hot/**'], routing: { keywords: [i < 2 ? 'boost' : 'zzz'] } }),
    );
    const p = poi({ id: 'p1', type: 'generic-diff', paths: ['hot/file.ts'], commitSubjects: ['boost'] });
    const out = routePois([p], entries, { ...CFG, top_k: 3 });
    expect(out.routes).toHaveLength(3);
    // Highest scores (owned+keyword=11) win; alphabetical tiebreak for the rest.
    expect(out.routes.map((r) => r.featureId)).toEqual(['feat.a', 'feat.b', 'feat.c']);
  });

  it('below-threshold PoIs fall to catch-all', () => {
    const p = poi({ id: 'p1', type: 'generic-diff', paths: ['unrelated/file.ts'], commitSubjects: ['proxy tweak'] });
    // keyword hit only (1 point) < threshold 6
    const out = routePois([p], [MITM, AGC], CFG);
    expect(out.routes).toEqual([]);
    expect(out.catchAll).toEqual(['p1']);
  });

  it('merge-conflict PoIs route to every owner/toucher of the conflicted file, uncapped', () => {
    const conflict = poi({
      id: 'c1',
      type: 'merge-conflict',
      class: 'gate',
      paths: ['src/container-runner.ts'],
      branches: ['feat/x'],
    });
    const out = routePois([conflict], [MITM, AGC, SKILLS], { ...CFG, top_k: 1 });
    // top_k=1 would keep only one, but conflict routing is uncapped for path matches.
    expect(out.routes.map((r) => r.featureId).sort()).toEqual(['feat.mitm', 'module.agc']);
  });

  it('catch_all.always_include classes get a global look even when routed', () => {
    const skill = poi({ id: 'p1', type: 'new-skill', paths: ['container/skills/demo/SKILL.md'] });
    const out = routePois([skill], [SKILLS], { ...CFG, catchAllAlwaysInclude: ['new-skill', 'new-top-level-dir'] });
    expect(out.routes.map((r) => r.featureId)).toEqual(['feat.skills']); // still routed (owned + forced)
    expect(out.catchAll).toEqual(['p1']); // AND sent to catch-all triage
  });

  it('fails closed: ALERTed and retired entries never receive routes', () => {
    const p = poi({ id: 'p1', type: 'generic-diff', paths: ['src/container-runner.ts'] });
    const retired = { ...AGC, status: 'retired' as const };
    const out = routePois([p], [MITM, retired], CFG, ['feat.mitm']);
    expect(out.routes).toEqual([]);
    expect(out.catchAll).toEqual(['p1']);
  });
});

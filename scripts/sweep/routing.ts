/**
 * scripts/sweep/routing.ts — deterministic PoI -> feature-entry router
 * (feature-inventory design §4).
 *
 * score = W.owned * |paths ∩ owned_paths| + W.touch * |paths ∩ touch_paths|
 *       + W.symbol * |symbol_watch hits in diff text / new basenames|
 *       + W.keyword * |keywords in commit subjects / new top-level dir names|
 * always_check_on forces score to at least the threshold. Routed entries are
 * capped at top_k, EXCEPT merge-conflict PoIs, which additionally route to
 * every entry whose owned/touch paths match a conflicted file (no cap).
 * PoIs matching nothing (or only validator-ALERTed entries) fail closed to
 * the catch-all triage.
 */
import { globMatchAny } from './globs.js';
import type { FeatureEntry, Poi, RouteResult, RoutingConfig, RoutingOutcome } from './types.js';

/** PoI classes for always_check_on matching (dockerfile-change is derived). */
export function poiClasses(poi: Poi): string[] {
  const classes = [poi.type as string];
  if (poi.paths.some((p) => /(^|\/)(Dockerfile[^/]*|entrypoint\.sh)$/.test(p))) classes.push('dockerfile-change');
  return classes;
}

export function scorePoi(poi: Poi, entry: FeatureEntry, cfg: RoutingConfig): RouteResult {
  const owned = poi.paths.filter((p) => globMatchAny(entry.owned_paths ?? [], p)).length;
  const touch = poi.paths.filter((p) => globMatchAny(entry.touch_paths ?? [], p)).length;

  let symbol = 0;
  const symbolCorpus = [poi.diffText ?? '', ...(poi.newBasenames ?? [])].join('\n');
  for (const pattern of entry.symbol_watch ?? []) {
    try {
      if (new RegExp(pattern, 'i').test(symbolCorpus)) symbol++;
    } catch {
      // invalid regex in registry: ignore (validator surfaces registry quality)
    }
  }

  const kwCorpus = [
    ...poi.commitSubjects,
    ...(poi.type === 'new-top-level-dir' ? poi.paths.map((p) => p.split('/')[0]) : []),
  ]
    .join('\n')
    .toLowerCase();
  const keyword = (entry.routing?.keywords ?? []).filter((k) => kwCorpus.includes(k.toLowerCase())).length;

  let score =
    cfg.weights.owned * owned + cfg.weights.touch * touch + cfg.weights.symbol * symbol + cfg.weights.keyword * keyword;
  const classes = poiClasses(poi);
  const forced = (entry.routing?.always_check_on ?? []).some((c) => classes.includes(c));
  if (forced) score = Math.max(score, cfg.threshold);

  return { poiId: poi.id, featureId: entry.id, score, components: { owned, touch, symbol, keyword, forced } };
}

export function routePois(
  pois: Poi[],
  entries: FeatureEntry[],
  cfg: RoutingConfig,
  alertedFeatureIds: string[] = [],
): RoutingOutcome {
  const alerted = new Set(alertedFeatureIds);
  // Fail closed: ALERTed entries never receive routes; retired entries are inert.
  const usable = entries.filter((e) => e.status !== 'retired' && !alerted.has(e.id));
  const routes: RouteResult[] = [];
  const catchAll: string[] = [];
  const byFeature: Record<string, string[]> = {};

  for (const poi of pois) {
    const scored = usable
      .map((e) => scorePoi(poi, e, cfg))
      .sort((a, b) => b.score - a.score || a.featureId.localeCompare(b.featureId));
    const above = scored.filter((s) => s.score >= cfg.threshold);
    const selected = new Map(above.slice(0, cfg.top_k).map((s) => [s.featureId, s]));
    if (poi.type === 'merge-conflict') {
      // Conflict PoIs also route to every owner/toucher of a conflicted file, uncapped.
      for (const s of scored) {
        if (selected.has(s.featureId)) continue;
        const entry = usable.find((e) => e.id === s.featureId)!;
        const hits = poi.paths.some(
          (p) => globMatchAny(entry.owned_paths ?? [], p) || globMatchAny(entry.touch_paths ?? [], p),
        );
        if (hits) selected.set(s.featureId, s);
      }
    }
    // Classes in catch_all.always_include get a global look even when routed.
    const alwaysCatchAll = (cfg.catchAllAlwaysInclude ?? []).some((c) => poiClasses(poi).includes(c));
    if (selected.size === 0 || alwaysCatchAll) catchAll.push(poi.id);
    for (const s of selected.values()) {
      routes.push(s);
      (byFeature[s.featureId] ??= []).push(poi.id);
    }
  }
  return { routes, catchAll, byFeature };
}

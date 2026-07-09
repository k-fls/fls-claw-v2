/**
 * scripts/sweep/scan.ts — per-branch conflict scan + PoI extraction.
 *
 * Conflicts: new-style merge-tree of each in-scope branch vs the upstream
 * ref. PoIs: walk the upstream first-parent range (rangeBase..upstreamRef)
 * and classify annotate-PoIs — new top-level dirs, new skill dirs (a new
 * directory gaining a SKILL.md under a skills root), new files over the size
 * threshold, sensitive-surface touches, dependency/SDK bumps. Emits
 * sweep-report.json (schema: types.SweepReport).
 */
import {
  DEP_PATHS,
  DIFF_TEXT_CAP_BYTES,
  LARGE_ANY_BYTES,
  LARGE_SOURCE_BYTES,
  SENSITIVE_PATHS,
  SKILL_ROOTS,
  SOURCE_EXTENSIONS,
} from './config.js';
import {
  blobSize,
  commitInfo,
  diffNameStatus,
  diffText,
  firstParentChain,
  listTopLevel,
  listTreePaths,
  revParse,
} from './git.js';
import { globMatchAny } from './globs.js';
import { findStopPoint } from './stop-points.js';
import type { BranchScan, Poi, PoiType, SweepReport } from './types.js';

export interface ScanOptions {
  largeSourceBytes?: number;
  largeAnyBytes?: number;
  sourceExtensions?: string[];
  sensitivePaths?: string[];
  skillRoots?: string[];
  depPaths?: string[];
}

interface RangeChange {
  path: string;
  status: string;
  sha: string;
  subject: string;
}

function poiIdFactory(): (type: PoiType, hint: string) => string {
  const seen = new Map<string, number>();
  return (type, hint) => {
    const base = `${type}:${hint.replace(/[^a-zA-Z0-9._/-]/g, '_')}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };
}

/** Classify one branch: merge-tree conflicts vs upstream + stop point. */
export async function scanBranch(repo: string, branch: string, upstreamRef: string): Promise<BranchScan> {
  const sp = await findStopPoint(repo, branch, upstreamRef);
  return {
    branch,
    clean: sp.cleanAtTip,
    conflictFiles: sp.conflictFiles,
    stopPoint: sp.stopPoint,
    upToDate: sp.upToDate,
  };
}

/** Extract annotate-PoIs over the upstream first-parent range rangeBase..upstreamRef. */
export async function extractPois(
  repo: string,
  rangeBase: string,
  upstreamRef: string,
  opts: ScanOptions = {},
): Promise<Poi[]> {
  const largeSource = opts.largeSourceBytes ?? LARGE_SOURCE_BYTES;
  const largeAny = opts.largeAnyBytes ?? LARGE_ANY_BYTES;
  const sourceExts = opts.sourceExtensions ?? SOURCE_EXTENSIONS;
  const sensitive = opts.sensitivePaths ?? SENSITIVE_PATHS;
  const skillRoots = opts.skillRoots ?? SKILL_ROOTS;
  const depPaths = opts.depPaths ?? DEP_PATHS;
  const nextId = poiIdFactory();

  const chain = await firstParentChain(repo, upstreamRef, rangeBase);
  const changes: RangeChange[] = [];
  for (const sha of chain) {
    const info = await commitInfo(repo, sha);
    // First-parent step diff (merge commit = the whole PR's effect).
    const from = info.parents[0] ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // empty tree
    for (const ch of await diffNameStatus(repo, from, sha)) {
      changes.push({ path: ch.path, status: ch.status, sha, subject: info.subject });
    }
  }
  if (changes.length === 0) return [];

  const baseTopLevel = new Set(await listTopLevel(repo, rangeBase));
  const baseFiles = new Set(await listTreePaths(repo, rangeBase));
  const pois: Poi[] = [];
  const poi = (type: PoiType, idHint: string, paths: string[], involved: RangeChange[], detail?: string): Poi => ({
    id: nextId(type, idHint),
    class: 'annotate',
    type,
    paths,
    upstreamCommits: [...new Set(involved.map((c) => c.sha))],
    commitSubjects: [...new Set(involved.map((c) => c.subject))],
    branches: [],
    detail,
  });

  // Added paths, first add wins (a path added then modified stays "added").
  const added = new Map<string, RangeChange>();
  for (const ch of changes) {
    if (ch.status === 'A' && !baseFiles.has(ch.path) && !added.has(ch.path)) added.set(ch.path, ch);
  }

  // 1. New top-level directories.
  const newTopDirs = new Map<string, RangeChange[]>();
  for (const [path, ch] of added) {
    const slash = path.indexOf('/');
    if (slash === -1) continue;
    const top = path.slice(0, slash);
    if (!baseTopLevel.has(top)) (newTopDirs.get(top) ?? newTopDirs.set(top, []).get(top)!).push(ch);
  }
  for (const [dir, chs] of newTopDirs) {
    pois.push(
      poi('new-top-level-dir', dir, [...new Set(chs.map((c) => c.path))], chs, `new top-level directory ${dir}/`),
    );
  }

  // 2. New skill directories (new dir gaining a SKILL.md under a skills root).
  for (const [path, ch] of added) {
    if (!path.endsWith('/SKILL.md')) continue;
    const root = skillRoots.find((r) => path.startsWith(r));
    if (!root) continue;
    const dir = path.slice(0, path.length - '/SKILL.md'.length);
    pois.push(poi('new-skill', dir, [path], [ch], `new skill ${dir}`));
  }

  // 3. New files over threshold.
  for (const [path, ch] of added) {
    const size = await blobSize(repo, ch.sha, path);
    if (size === null) continue;
    const isSource = sourceExts.some((ext) => path.endsWith(ext));
    const threshold = isSource ? largeSource : largeAny;
    if (size > threshold) {
      pois.push(poi('large-new-file', path, [path], [ch], `${size} bytes (threshold ${threshold})`));
    }
  }

  // 4. Sensitive-surface touches (one PoI per touched sensitive path).
  const sensitiveTouches = new Map<string, RangeChange[]>();
  for (const ch of changes) {
    if (globMatchAny(sensitive, ch.path)) {
      (sensitiveTouches.get(ch.path) ?? sensitiveTouches.set(ch.path, []).get(ch.path)!).push(ch);
    }
  }
  for (const [path, chs] of sensitiveTouches) {
    pois.push(poi('sensitive-surface-touch', path, [path], chs));
  }

  // 5. Dependency / SDK bumps.
  const depTouches = new Map<string, RangeChange[]>();
  for (const ch of changes) {
    if (globMatchAny(depPaths, ch.path)) {
      (depTouches.get(ch.path) ?? depTouches.set(ch.path, []).get(ch.path)!).push(ch);
    }
  }
  for (const [path, chs] of depTouches) {
    pois.push(poi('dep-change', path, [path], chs));
  }

  return pois;
}

/**
 * Fill diffText/newBasenames on report PoIs for symbol_watch routing
 * (route stage; kept out of the report file to bound its size).
 */
export async function enrichPois(repo: string, report: SweepReport): Promise<Poi[]> {
  const enriched: Poi[] = [];
  for (const poi of report.pois) {
    const withDiff: Poi = { ...poi };
    if (poi.paths.length > 0) {
      withDiff.diffText = await diffText(repo, report.rangeBase, report.upstreamTip, poi.paths, DIFF_TEXT_CAP_BYTES);
      withDiff.newBasenames = poi.paths.map((p) => p.split('/').pop()!).filter(Boolean);
    }
    enriched.push(withDiff);
  }
  return enriched;
}

export interface BuildReportOptions extends ScanOptions {
  /** Skip the stop-point bisection (conflict lists only). */
  skipStopPoints?: boolean;
}

/** Full scan: per-branch conflicts + stop points + range PoIs -> SweepReport. */
export async function buildReport(
  repo: string,
  branches: string[],
  upstreamRef: string,
  rangeBase: string,
  opts: BuildReportOptions = {},
  warnings: string[] = [],
): Promise<SweepReport> {
  const upstreamTip = await revParse(repo, upstreamRef);
  const branchScans: Record<string, BranchScan> = {};
  for (const branch of branches) {
    branchScans[branch] = await scanBranch(repo, branch, upstreamRef);
  }
  const pois = await extractPois(repo, rangeBase, upstreamRef, opts);
  // Conflict PoIs (gate class) from the branch scans.
  const nextId = poiIdFactory();
  for (const scan of Object.values(branchScans)) {
    if (!scan.clean && scan.conflictFiles.length > 0) {
      pois.push({
        id: nextId('merge-conflict', scan.branch),
        class: 'gate',
        type: 'merge-conflict',
        paths: scan.conflictFiles,
        upstreamCommits: [upstreamTip],
        commitSubjects: [],
        branches: [scan.branch],
        detail: `merge of ${upstreamRef} into ${scan.branch} conflicts`,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo,
    upstreamRef,
    upstreamTip,
    rangeBase: await revParse(repo, rangeBase),
    branches: branchScans,
    pois,
    warnings,
  };
}

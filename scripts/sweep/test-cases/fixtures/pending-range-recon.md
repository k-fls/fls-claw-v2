# Pending upstream range recon — cb6e3d11..0c0f4c25

Snapshot date: **2026-07-10**. Range: `cb6e3d117c127054ca5bc5a53645d794d93cc595`
(v2.1.23, current `main`) .. `0c0f4c2592d7f4191eff92e7d4a3a9b7042f74d9`
(`upstream/main`, v2.1.41+). **56 first-parent commits (128 total); 169 files
changed, +9927/−2848.** This doubles as recon for the first automated sweep.
All conflict sets below were produced live with new-style `git merge-tree`
against current branch tips; all SHAs verified.

## Themes

1. **ncl-tasks** — #2980 (`2480ae7c`, CLI verb-args human view, new
   `src/cli/help-render.ts`) + **#2981 tasks-core (`f7a43ef8`) — the big one**:
   deletes `src/modules/scheduling/{index,actions}.ts` and
   `container/agent-runner/src/mcp-tools/scheduling.ts`, rewires
   `src/modules/index.ts`, `host-sweep.ts`, `session-db.ts`, `delivery.ts`,
   `poll-loop.ts`, `providers/claude.ts`, adds 35 KB
   `src/cli/resources/tasks.ts` + `docs/ncl-tasks-migration.md`.
2. **cleanup/* series** — the fork-relevant killers:
   - **#2942 (`c1965cfc`) DELETES `container/agent-runner/src/current-batch.ts`**
     (stamping moved into `db/session-state`) → modify/delete conflict against
     the fork's `fix/main/duplicate-send-message-reply` on every
     `main_patched` descendant.
   - **#2930 (`6dc25a9b`) command-gate start+failopen** + new upstream
     `src/command-gate.test.ts` → content + add/add conflicts against
     `fix/main/command-gate-mention-prefix` (the fork's open slash-command
     bug fix lives in exactly this file).
   - #2935 dead-v1-config, #2937 resolve-session-reprovision, #2940 onedb
     shims, #2932 dispatch longest-prefix, #2927 unregister-mock-provider.
3. **Templates** (#2890, `c87f2e55`, third-party): new `templates/` +
   `src/templates/`, `group-persona`/`group-skills`, and a rewrite of
   `src/cli/resources/groups.ts` create/`--template` — conflicts with
   `fix/ncl-crud-side-effects`' groups.ts handler on every branch carrying
   `main_patched`.
4. **Security/egress** (T8 surface): #2934 (`776bc14c`) reachable-perimeter-env
   (`src/egress-lockdown.ts` + `src/config.ts`), #2943 (`b7d6eebf`)
   mount-allowlist readonly+cache (`src/modules/mount-security/`), #2946
   (`023128de`) removes the env-secrets mirror (setup/* channel auth), #2928
   (`2938bbf9`) removes a dead global mount, #2931 (`273489ba`) async image
   build (`src/container-runner.ts`). Direct feature-overlap with fork
   `module/egress-lockdown` (content conflict + same-path test add/add).
5. **Provider/docs/misc**: #2965 (`04b364e8`) rate-limit event shape — touches
   only `container/agent-runner/src/providers/claude.ts`; currently
   auto-merges against fork branches but overlaps the fork's
   `classifyResultMessage` machinery → semantic watch-item. Docs rewrites
   #2953/#2961–#2964; add-clidash skill #2795 (`01b07d66`, 36-file payload);
   approval-button-styles #2933; onecli-approval-card-summary #2929;
   core-team-pr-label #2978; approval-cli-caller-context #2611.

## Live conflict matrix (merge-tree vs upstream/main, current tips, 2026-07-10)

| fork branch | tip | conflicted files |
|---|---|---|
| `main_patched` | `ad619134` | 4 — current-batch.ts (M/D), poll-loop.ts, groups.ts, command-gate.test.ts (add/add) |
| `module/crypto` | `ac901a46` | 3 — core set minus command-gate |
| `module/runtime-updater` | `677714a9` | 8 — core + command-gate.ts, config.ts, container-runner.ts, modules/index.ts |
| `module/egress-lockdown` | `01b10d1c` | 12 — + egress-lockdown.ts, host-sweep.ts, mount-security test (add/add), SECURITY.md |
| `feat/mitm-credential-proxy` | `4d386dba` | 15 — + CLAUDE.md, package.json, src/index.ts |
| `feat/onecli-broker` | `49f6b072` | 16 — + src/cli/resources/index.ts |
| `edition/fls-ai-bot` | `ca2fec60` | 15 — same set as mitm |
| `fix/ncl-crud-side-effects` | `94db9f4e` | 1 — groups.ts |
| `fix/main/command-gate-mention-prefix` | `9f5d74b4` | 1 — command-gate.test.ts (add/add) |
| `fix/main/duplicate-send-message-reply` | `41d31879` | 3 — current-batch.ts (M/D), poll-loop.ts, mcp-tools/core.ts |
| clean (merge-tree exit 0) | | `fix/duplicate-result-dispatch`, `fix/chat-sdk-format-fallback`, `fix/main/chat-sdk-mention-boundary`, `docs/notes` |

The shared 4-file core (current-batch M/D, poll-loop.ts, groups.ts,
command-gate.test.ts) originates entirely in `main_patched`'s three
`fix/main/*` constituents.

## Notable PoIs in the range

- New skill dir: `.claude/skills/add-clidash/` (#2795, third-party, executable
  JS dashboard payload).
- New folders: `templates/` + `src/templates/` (#2890, third-party).
- Large new files (>15 KB): `src/cli/resources/tasks.ts` (34795 B),
  clidash `public/app.js` (33067 B), `tasks.test.ts` (23018 B),
  clidash `icon-512.png`/`style.css`/`server.js`.
- Security-surface commits: #2946, #2943, #2934, #2931, #2928 (see
  `cases/t8b-pending-security-commits.yaml`).

## First-sweep advice

1. **Resolve the shared core ONCE on `main_patched`, then propagate.**
   The current-batch fix must be re-homed onto upstream's `db/session-state`
   (semantic, see `t4-live-currentbatch-delete`); the command-gate
   mention-prefix fix must be re-expressed against #2930's start/failopen
   rewrite; groups.ts side-effects handler must be reconciled with #2890's
   `--template` create.
2. Only then handle per-branch deltas: `modules/index.ts` vs #2981's registry
   rework, `container-runner.ts` vs #2931/#2928, and the egress/mount-security
   feature overlap (route to `features/module.egress-lockdown.yaml`
   overlap-check; escalate).
3. `module/crypto` and the other roots now merge `main_patched` directly —
   the June "resolve identically everywhere, byte-identical reuse" discipline
   applies again; seed rerere from the T2 pins first.
4. Watch-items to re-confirm during the sweep (from the June semantic-alignment
   audit): version-aware `resolveProviderName`/`parseProviderSpec` must survive
   the #2981/#2890 merges; #2965's rate-limit event shape vs the fork's
   `classifyResultMessage` in `providers/claude.ts` (auto-merges, needs a
   semantic look).
5. Excluded from sweep: `fix/channels/telegram-markdown-nesting` (750 behind,
   see `cases/t10-telegram-ancient.yaml`), `experimental/*`, `wip/*`,
   `everything*`, `worktree-agent-*`, `maint/fork-registry`.

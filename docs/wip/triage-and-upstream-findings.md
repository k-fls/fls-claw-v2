# WIP triage — upstream reality, branch routing, and a corrected #9 root cause

Date: 2026-06-20. Inputs: `docs/wip/first-use-bugs.md`, `docs/wip/first-use-fixes.md`.
Verified against the `everything` working tree and the real upstream.

---

## 0. Upstream reality (this changes the baseline)

- **`kfls` (`k-fls/fls-claw-v2`) is NOT our upstream.** It is an independent, stale
  mirror — `isFork:false`, no GitHub parent. It just re-publishes nanoclaw content.
- **True upstream = `nanocoai/nanoclaw`** (public, default branch `main`). Added as the
  `upstream` remote.
- **Our fork point is exact and clean.** Local `main` == `kfls/main` == nanocoai commit
  **`d85efea2` ("chore: bump version to 2.1.1", 2026-06-08)**. `main` *is* an ancestor of
  `upstream/main`. The merge-base of `everything` (all our feature work) and
  `upstream/main` is also `d85efea2`. So every feature/module branch forked from v2.1.1.
- **We are 127 commits behind.** `main...upstream/main = 0 / 127`. Upstream is now
  **v2.1.19**; we are pinned at **v2.1.1**.
- **None of the 127 upstream commits touch the bug files.** `git log main..upstream/main --
  src/cli/crud.ts src/cli/resources/groups.ts src/cli/resources/wirings.ts
  src/cli/resources/messaging-groups.ts` → empty. So bugs #4/#5/#6 are **still unfixed at
  v2.1.19** — our fixes would be genuinely new upstream contributions.
- Recently merged upstream (egress-lockdown `src/egress-lockdown.ts`, upgrade-tripwire,
  a2a approval policies) touches **none** of our buggy files. egress-lockdown is a
  *parallel* egress-control model to our `mitm-proxy` + `onecli-broker` — a future-merge
  reconciliation concern, not a fix for any open bug.

**Implication for "check upstream for fixes":** there are no upstream fixes to pull for
any of these bugs. But there are 127 commits of drift to plan a catch-up merge for,
off a clean `d85efea2` fork point.

---

## 1. Branch routing principle

- **Group A — fix on the owning feature/module branch, merge up.** The buggy file does
  not exist on `upstream/main` (repo-introduced functionality).
- **Group B — separate fix branch off `d85efea2`/`main`, upstreamable to nanocoai.** The
  buggy file exists on `upstream/main` unchanged by our branches.
- **Group C — already fixed / deferred / out of scope.**

Docker-split items (fixes-doc #2/#7) excluded per instruction. #8 dropped (deployment, not code).

---

## 2. Group B — upstream CLI bugs (one shared root cause) → `fix/ncl-crud-side-effects`

`src/cli/crud.ts` exists on `upstream/main`; the resource defs are generic single-table.

**Shared root cause (verified in `src/cli/crud.ts`):**
- `genericCreate` (l.129) does a bare single-table `INSERT` — no domain side-effects.
- `genericUpdate` (l.165) only iterates `updatable` columns and silently ignores every
  other flag — no validation that a passed `--flag` maps to a real updatable column.

| Bug | Mechanism | Fix |
|-----|-----------|-----|
| **#4** `groups create` unspawnable | generic INSERT never calls `ensureContainerConfig` (which `group-init.ts:70` does) → `materializeContainerJson` throws `Container config not found` on spawn | custom/post-`create` hook for `groups` calling `ensureContainerConfig(id)` |
| **#5** `wirings create` no destination | generic INSERT bypasses `createMessagingGroupAgent` (`db/messaging-groups.ts:133`) which auto-creates the `agent_destinations` row → agent drops `<message to="cli">` | route `wirings create` through `createMessagingGroupAgent`, guarded by `hasTable('agent_destinations')` |
| **#6** `wirings update --agent-group-id` silent no-op | `agent_group_id` is `required`, not `updatable`; `genericUpdate` never reads non-updatable flags and emits no error | (1) general: reject unrecognized/non-updatable `--flags`; (2) decide intent for re-pointing a wiring (custom op + destination re-projection, or explicit error) |

**Recommended upstream-quality fix:** add first-class `afterCreate`/`afterUpdate` hooks to
`ResourceDef` (the CRUD layer currently assumes resource == one table, no side-effects;
#4/#5 prove several resources have creation side-effects). `groups`/`wirings` register
theirs. Pitch this shape to nanocoai.

---

## 3. Group A — repo-introduced functionality

### A1 · #3 credential filename incompatibility → `module/credentials`
- **Confirmed.** `listProviderIds` (`store.ts`) uses greedy `/^(.+)\.json$/` →
  `claude.keys.json` yields provider id `claude.keys`, not `claude`. Acquisition gate
  (`credential-acquisition.ts`) then reports `missing=['claude']`.
- **Fix:** canonicalize on read (map `<prov>.keys.json`/`<prov>.refs.json` → `<prov>`),
  or strip the known compound suffix set. Add a unit test with v1-style names.
  Self-contained, lowest risk.

### A2 · #9 auth-container host-rpc rejection — CORRECTED ROOT CAUSE
**The earlier "long-lived agent container survives a host restart" theory is WRONG.**
Retired. The release is tied to `fireContainerExited` for agents and to a local
`finish()` for auth, so live containers stay registered for their lifetime — restart is
not required and not the cause.

**Two structural defects, both verified by reading the code:**

1. **The auth container does NOT reuse the agent container's prepare/init pipeline.** It
   is a parallel reimplementation:
   - Agent: `spawnContainer` → `buildContainerArgs` → `fireSpawnPre` → **ip-observer** →
     `allocateContainerIP(scope, session.id)`; release on `fireContainerExited`.
   - Auth: `spawnAuthContainer` (`auth-container.ts:155`) → its own `buildAuthSpawnArgs`
     + direct `allocateContainerIP(opts.scope)` (no sessionId); release in a local
     promise `finish()`. It borrows only `defaultLaunchShape().mounts` — not the
     lifecycle/IP observer pipeline.

2. **The explicit `--ip` is being silently dropped for the auth container, so Docker
   auto-assigns.** This is the actual fault — proven by elimination, below.

**Proof that the fault is a dropped `--ip`, not a registry/pool desync:**
- Orphan cleanup *kills* prior-run containers at host startup (`container-runtime.ts:87`);
  it does not adopt them, and `byIp` is never seeded from running containers. So there are
  no live-but-unregistered containers — the "restart leaves a stale IP" path cannot occur.
- The allocator is `allocateContainerIP` → `allocateIPFromPool` (`network.ts:53`), a
  monotonic counter whose only "free" test is `!byIp.has(ip)`. The counter climbs and
  never rewinds; Docker's own IPAM reuses the lowest free address. These two *would*
  diverge — **except that the explicit `--ip` forces Docker onto the pool's chosen value.**
  So as long as `--ip` is honored, `byIp[chosen] == actual container IP` holds **even
  under heavy respawn churn**. There is no desync to reconcile.
- Therefore the only way the host can see an IP that is absent from `byIp` is if the
  explicit `--ip` did **not** take effect and Docker auto-assigned. The observed
  `callerIP=172.29.0.4` is exactly Docker's lowest-free auto-assignment (.2/.3 held by
  main/geosafe → .4), i.e. the fingerprint of a dropped `--ip`. Agent containers appear to
  "work" only because, at low churn, the pool's choice and Docker's auto-assignment
  coincide on the low addresses.

**Why `inspect`-then-register is the WRONG fix:** reading the container's IP back via
`docker inspect` after spawn is racy (TOCTOU) — the endpoint may not be attached yet, the
address can change on reconnect, and it just records whatever Docker did instead of
*enforcing* the assignment. The IP must be assigned **explicitly and authoritatively in
both paths**; the registry value is then correct by construction.

**Not yet pinned (needs the box's `run.log` — the literal `docker run` argv):** the precise
reason the auth container's `--ip` is dropped. Top candidate: the MITM-proxy path connects
the auth container to a **second** network endpoint, which makes `--ip` ambiguous and
Docker ignores it (single-network is a hard requirement for static `--ip`). Other
candidates: an arg-ordering difference between `buildAuthSpawnArgs` and the agent
pipeline, or a falsy `allocated.ip`. This is exactly the kind of divergence that
disappears once auth stops reimplementing the spawn path.

**Fix (primary branch `module/container-bootstrap`):**
1. **One shared, explicit IP-assignment path.** Route `spawnAuthContainer` through the same
   `fireSpawnPre`/ip-observer allocation+register code the agent path uses, instead of its
   parallel `buildAuthSpawnArgs` + direct `allocateContainerIP`. Both container types then
   assign `--ip` identically. (Touches `auth-container.ts` — `feat/mitm-credential-proxy`.)
2. **Make the explicit assignment authoritative — fail loud, never auto-assign.** Ensure
   the container is on exactly one network so `--ip` is honored; if `--ip` cannot be applied
   (collision / second endpoint / ambiguity), the spawn must **fail**, not silently fall
   through to Docker's IPAM. No `docker inspect` readback.
3. **(Optional) host-rpc clarity (`module/host-rpc`):** on a `lookupContainerIP` miss,
   reject with a diagnostic that names the unregistered IP and the live `byIp` set, so this
   class of fault is self-evident in the log rather than a bare "unknown caller IP".

(#8 geosafe fresh Claude login is a deployment issue, not code — dropped from this triage.)

### A3 · #10 GitHub API 401 → `feat/mitm-credential-proxy` (investigate-then-fix)
- **Root cause not determined**; two runtime unknowns remain (did the container receive a
  non-empty `GH_TOKEN`/`GITHUB_TOKEN` substitute; did the request carry an `Authorization`
  header the proxy could swap). Credential is a device-flow `oauth` entry (no `api_key`);
  substitute config is token-format dependent (`pickSubstituteConfigForToken`).
- **Plan:** repro on the box — (1) confirm env bindings deliver a non-empty substitute
  into the container; (2) capture the proxy's inbound `Authorization` for `api.github.com`;
  (3) verify `to/fromTransport` round-trips a `gho_`/device-flow token under the selected
  substitute config. Fix lands in `github-credential.ts` / `mitm-proxy/defaults.ts`.
  Lower priority (no fresh-login dependency).

---

## 4. Group C

- **#11 Telegram outbound — OPEN in repo terms (fix exists only on the box).** Verified:
  `telegram-markdown-sanitize.ts` exists only on upstream (nanocoai) channels branches,
  not on any `origin`/local branch; the bridge fallback (`isFormatError`/`toPlainText`) is
  absent from every branch and the working tree. The box hand-edits were never ported
  back. To land it: bridge fallback → trunk `src/channels/chat-sdk-bridge.ts`; sanitizer
  nesting fix → the `channels`-branch copy of `telegram-markdown-sanitize.ts` (patching an
  upstream-owned file). Both must be lifted from the box.
- **#12 Telegram typing — OPEN, deferred.** `channels`-branch concern; cosmetic.
- **#8 geosafe fresh Claude login — DROPPED.** Deployment issue, not code.
- **Docker-split (#2/#7)** — excluded per instruction.

---

## 5. Recommended sequencing

1. **Group B** (`fix/ncl-crud-side-effects` off `main`/`d85efea2`) — fully understood,
   no box needed, immediately upstreamable. First.
2. **A1 (#3)** on `module/credentials` — small, unit-testable. Merge up.
3. **A2 (#9)** — unify auth + agent onto one explicit IP-assignment path on
   `module/container-bootstrap`; make `--ip` authoritative (fail loud, never auto-assign);
   no inspect/readback. Touches `auth-container.ts` (`feat/mitm-credential-proxy`).
   Confirm the dropped-`--ip` mechanism from the box's `docker run` argv.
4. **A3 (#10)** — box repro required; last.

---

## 6. Open question for the user: upstream/origin remote layout

Current remotes: `kfls` (stale mirror) + `upstream` (= `nanocoai/nanoclaw`, just added).
There is no `origin`. Our base is exactly `d85efea2` (nanocoai v2.1.1). Options for
making nanocoai canonical and planning the 127-commit catch-up are in the chat reply.

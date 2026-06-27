# Upstream semantic-alignment findings (post 2026-06 sweep)

After merging ~150 upstream commits (`d85efea2` → `upstream/main` `2afbd182`) into every
fork branch, we audited for **semantic** alignment — places our fork independently built
something upstream has since introduced, that the textual merge wouldn't flag because the
code lives in different files. Reusable audit brief: [`docs/fls/upstream-alignment-analysis.prompt.md`](fls/upstream-alignment-analysis.prompt.md).

**Bottom line: there are effectively NO must-change semantic alignments.** The fork's big
modules (credential/MITM proxy, host-RPC, SSH-auth, crypto, container-bootstrap) are
net-new territory upstream never entered, so there is nothing to converge there. Only two
items are worth remembering, and neither is urgent.

## #1 — `container_configs.provider` version encoding — WATCH-ITEM, not a break

runtime-updater overloads `container_configs.provider` with a `:version` suffix
(`claude:2.1.154`); upstream's operator-driven provider selection (`13a37def`) treats
`provider` as a clean name and has **no version concept** (`upstream/main` has no
`parseProviderSpec`; its `resolveProviderName` just lowercases, and its `configFromDb`
reads `row.provider` raw).

An earlier audit pass claimed this "will break upstream's parser once codex is exercised."
**That claim is wrong for our merged tree** — verified:
- The sweep kept OUR version-aware parser and dropped upstream's naive one
  (`fix: drop duplicate base resolveProviderName — runtime-updater's version-aware one wins`).
  Merged tree has exactly one `resolveProviderName` (`resolveProviderSpec(...).id`, strips the
  colon), `parseProviderSpec` present, `configFromDb` splits the suffix. Upstream's naive
  `(... || 'claude').toLowerCase()` is gone (0 hits).
- `parseProviderSpec` is provider-agnostic — `codex:1.2.3` splits exactly like `claude:…`.
  "Non-Claude" was a red herring.

So the colon is parsed **consistently everywhere** in the merged fork; nothing breaks. What
remains is only a **convention divergence**: we overload the column, upstream keeps it clean.
It stays coherent only as long as OUR version-aware `resolveProviderName` / `configFromDb`
remain the ones in the tree.

**Action: none now. Watch-item** — on any future upstream pull that touches provider
resolution, re-confirm our version-aware `resolveProviderName`/`parseProviderSpec`/`configFromDb`
still override upstream's naive ones, so the `:version` encoding keeps being parsed. (If we
ever want to upstream provider-related code, drop the encoding and carry version elsewhere.)

## #2 — Approvals: keep ours; converge response-bookkeeping LATER

Our `src/host-interactions.ts` / `src/modules/interactions/pick-from-buttons.ts` substrate is
**synchronous / in-memory / N-option** (seizes the routing slot, pauses outbound, multi-turn
ask-finish-cancel). `ssh-auth` and credential-reauth depend on those sync semantics — it is
**not substitutable** by upstream's async/durable reject-with-reason flow
(`src/modules/approvals/reason-capture.ts`, `finalize.ts`). **Don't replace it.**

The only worthwhile convergence is *later*: re-express our response-bookkeeping on top of
upstream's now-standard `registerApprovalResolvedHandler` / `notifyApprovalResolved` so we
stop maintaining a parallel response-relay path. **Refactor, not behavior change.** Both
already share the upstream base `pickApprover`/`pickApprovalDelivery` (in `primitive.ts`,
which is upstream's, not ours).

Merge-hygiene reminder: upstream generalized the router interceptor to a *list*; our
interactions also hook router inbound + `isOutboundPaused`. On future merges, verify both
interceptor consumers coexist and don't both consume the same DM.

## Orthogonal — compose cleanly, no alignment (recorded so we don't re-litigate)

- **Per-container CPU/mem limits (upstream `1d6bba4d`)** vs **container-queue (ours)** — size-cap
  vs count-cap; different axes; compose.
- **`cli-tools.json` build-time CLI manifest (upstream `adfae676`)** vs **runtime-updater (ours)** —
  image baseline vs per-group runtime override; layered. Keep the baked `claude-code` pin
  coherent with what `/agent-runtime` reports as the image-baked default.
- **agent-surfaces capability `providerProvidesAgentSurfaces` (upstream `14810a50`)** vs
  **agent-group-contributions registry (ours)** — subtractive provider-keyed vs additive
  module-keyed; opposite mechanics; compose in `buildMounts`. Do NOT route our contributions
  through `providerProvidesAgentSurfaces`. (The `defaultAgentSurfaces()` split done during the
  sweep already gates our surface *mounts* on it; the contributions registry stays separate.)

## Rejected as "ours to align" (were upstream/base code — verify before re-raising)

`memory-scaffold`, the approval `primitive`/`pickApprover`, `CLAUDE.local` seeding,
`command-gate` (same-file fork-mod, already merge-decided), `webhook-server` / a2a
message-gate (no fork-side parallel) — all live on `upstream/main` or have no fork counterpart.

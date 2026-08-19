# Residual review findings — Slack working indicator

- **Branch:** `fix/main/slack-working-indicator`
- **Head at review:** `bdba6b06` (fixes applied in `e268a386`)
- **Plan:** `docs/plans/2026-08-18-001-fix-slack-working-indicator-plan.md`
- **Reviewed:** 2026-08-18, `main_patched..HEAD`
- **Reviewers:** correctness, project-standards, testing, maintainability, reliability (local);
  adversarial via cross-model Codex (`independence_verified: true`, requested `gpt-5.6-luna`
  at xhigh, served model/effort `unverified` — the route carries no receipt).
- **Disposition:** accepted by the operator, not fixed. Recorded so they outlive the session.

Everything below was raised by a reviewer and deliberately left alone. Findings that WERE
fixed are in commit `e268a386` and are not repeated here.

---

## 1. A failed indicator removal strands it forever

- **Severity:** P2 · reliability (anchor 75), corroborated by cross-model Codex
- **Where:** `src/modules/typing/index.ts` — `releaseIndicator`

A reaction does not expire the way a native typing indicator does, and nothing ever
revisits that message: the next burst targets a *new* message. So a single transient
failure on the remove leaves the emoji on the user's message permanently.

`e268a386` added a `log.warn` on this path, so it is at least observable. It did not add a
retry. The reviewer's suggestion was one delayed retry on the removal side only, leaving
the add side's invisible degradation as-is.

**Why left:** the plan scopes the whole feature best-effort and lists indicator-state
persistence as a non-goal; a retry introduces async machinery (a timer, and a decision
about which `failed` outcomes are worth retrying — benign drift is not) into a path whose
design principle is that it can never affect routing or delivery. Worth revisiting if
production logs show this warn firing.

## 2. Bridge `deleteMessage` propagates instead of swallowing

- **Severity:** P2 · maintainability (anchor 50, advisory)
- **Where:** `src/channels/chat-sdk-bridge.ts`

`pulseReaction` swallows and reports through its return value; `deleteMessage` lets the
platform error propagate, and its only caller (`deletePlaceholder`) catches.

**Why left:** `deleteMessage` returns void, so it has no outcome channel to report through,
and it matches its actual siblings — `deliver` and `editMessage` both propagate. Making it
swallow would leave the bridge internally inconsistent in a different direction and hide
errors from any future caller. The asymmetry is deliberate.

## 3. Delivery to a different destination chat blinks the indicator

- **Severity:** residual risk · correctness
- **Where:** `src/delivery.ts` → `pauseTypingRefreshAfterDelivery`

The pause fires for every non-system, non-agent outbound row, including a send addressed to
a different chat than the one the indicator sits on. The indicator blinks off and returns
~12s later even though nothing landed in its conversation.

**Why left:** pre-existing behavior of the post-delivery pause; this change inherits it
rather than introducing it. Fixing it means teaching the pause about destination identity,
which is a separate change with its own blast radius.

## 4. Only `routeInbound` starts a refresher

- **Severity:** residual risk · correctness
- **Where:** `src/router.ts` is the sole caller of `startTypingRefresh`

A wake that engages an agent without going through `routeInbound` — the host-sweep
due-message wake, scheduled task sessions — produces no indicator at all.

**Why left:** pre-existing; the same gap applied to `setTyping` before this change. The
indicator simply inherits the existing coverage. Noted because this change makes the
absence more noticeable on Slack, where there was previously no visible indicator anyway.

## 5. No test exercises the real Slack adapter

- **Severity:** testing gap · correctness, and a plan assumption
- **Where:** `src/channels/chat-sdk-bridge.test.ts` stubs the Chat SDK adapter

Nothing verifies that `@chat-adapter/slack`'s `addReaction(threadId, messageId, emoji)`
accepts a channel-only thread id such as `slack:C1`, which is exactly what the bridge
passes. An address-shape or signature mismatch would ship undetected.

**Why left:** not fixable here — `@chat-adapter/slack` is not installed in this checkout
(only `@chat-adapter/telegram` is), because Slack installs from the `channels` branch via
`/add-slack`. This is precisely what the plan's Validation Approach step 2 covers: a
personal free Slack workspace as the real test environment. **This is the highest-value
remaining verification for this feature.**

---

## Related operator prerequisites (from the plan, not review findings)

- Whether the production Slack app holds `reactions:write` is still unestablished. If it
  does not, U5's placeholder fallback is the path that actually runs until the app is
  reinstalled with the scope and its new `xoxb-` token is stored.
- The animated experience needs a ≤128 KB, 128×128 animated GIF uploaded to the workspace
  as a custom emoji, with its name set in `SLACK_TYPING_EMOJI`. Without it the feature
  ships correctly in its static form.
- The `reactions:write` latch is process-lifetime by design. After adding the scope and
  reinstalling, the host must be restarted — which it needs anyway to pick up the new token.

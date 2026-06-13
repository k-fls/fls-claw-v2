# Interactions helpers

## Summary

The interactions module gives consumers a small, domain-agnostic
vocabulary for the most common interactive moments inside a host
command: ask the user to paste plain text, ask them to paste a
PGP-encrypted blob, ask an approver to pick one of N buttons, and ask
an approver to confirm or cancel an action. Each helper is a single
`await` that hides the underlying primitives (host interactions and
the approvals card flow) along with the messy parts — armor
normalization, decrypt-failure re-prompts, validator retries — so
consumers see only a final outcome and stay focused on what to do with
the captured text or chosen option.

The module is dormant: nothing imports it from the module barrel.
Consumers import the helpers directly and nothing runs at module load.

## Capabilities

- Consumers can prompt a user for free-form text in the originating
  thread and `await` the answer (or a cancel / timeout signal).
- Consumers can prompt a user for a PGP-encrypted blob, have it
  normalized, decrypted against a caller-provided `GNUPGHOME`, and
  optionally validated — receiving only the final cleartext, with
  bad-input retries handled transparently inside the helper.
- Consumers can ask an eligible approver to pick one of N labelled
  options through the chat-sdk button card and `await` the chosen
  value.
- Consumers can ask an eligible approver to confirm or cancel an
  action (with an optional URL embedded in the question body).

## Public contract

All helpers live under `src/modules/interactions/`:

```ts
import {
  pastePlain, pastePgp,
  pickFromButtons, confirmAction,
  type PasteResult, type PastePgpResult,
  type PickOption, type PickResult,
  type ConfirmResult,
} from './index.js';
```

### `pastePlain(opts)`

```ts
function pastePlain(opts: {
  ctx: HostCommandContext;
  prompt: string;
  timeoutMs?: number;          // default: host-interactions default (10 min)
  cancelKeywords?: string[];   // default: ['cancel', '/cancel', 'stop']
  validate?: (text: string) => string | null;
}): Promise<{ text: string | null; reason: 'submitted' | 'cancelled' | 'timeout' }>;
```

Opens a host interaction on the originating slot via
`ctx.beginInteraction`. The inbound chat envelope is unwrapped (the
`{ text }` JSON shape, falling back to the raw string) before matching.
Cancel matching is case-insensitive and ignores surrounding whitespace.
The original text is returned **untrimmed** on submit — callers that
need trimming do it themselves. `validate` returns `null` to accept and
resolve; returning a non-null string keeps the slot open and re-prompts
the user with that error message.

### `pastePgp(opts)`

```ts
function pastePgp(opts: {
  ctx: HostCommandContext;
  prompt: string;
  timeoutMs?: number;
  cancelKeywords?: string[];
  gpgHome: string;             // absolute path to a GNUPGHOME directory
  validate?: (plaintext: string) => string | null;
}): Promise<{
  text: string | null;
  reason: 'submitted' | 'cancelled' | 'timeout';
}>;
```

Captures a PGP-encrypted blob, checks it has the BEGIN/END armor
headers (`isPgpMessage`), normalizes armor whitespace
(`normalizeArmoredBlock`), decrypts against `gpgHome` (`gpgDecryptAt`),
and optionally runs `validate` on the cleartext. Bad input — a paste
without PGP headers, a decrypt error, or a validator rejection — keeps
the slot open and re-prompts the user with the error inline. The retry
loop is internal: consumers see only `'submitted'`, `'cancelled'`, or
`'timeout'`. `gpgHome` is a parameter, not resolved internally — the
right homedir for a given credential scope is the calling module's
concern.

### `pickFromButtons(opts)`

```ts
function pickFromButtons(opts: {
  session: Session;
  agentName: string;
  title: string;
  question: string;
  options: { value: string; label: string }[];
}): Promise<{ value: string | null; reason: 'picked' | 'declined' | 'timeout' }>;
```

Picks an eligible approver via the approvals primitive (`pickApprover`
→ `pickApprovalDelivery`) and delivers a chat-sdk `ask_question` card to
their DM. Resolves with the chosen option's `value` on click. Returns
`reason: 'declined'` when the `options` array is empty, no approver is
configured, no DM destination is reachable, the delivery adapter is
absent, the delivery throws, or the responder returns a value not in
`options`.

### `confirmAction(opts)`

```ts
function confirmAction(opts: {
  session: Session;
  agentName: string;
  title: string;
  question: string;
  url?: string;
  confirmLabel?: string;       // default 'Confirm'
  cancelLabel?: string;        // default 'Cancel'
}): Promise<'confirmed' | 'cancelled' | 'timeout'>;
```

A two-option `pickFromButtons` with fixed `confirm` / `cancel` values.
It returns `'confirmed'` only when the approver clicks the confirm
button; every other outcome — clicking cancel, a declined pick, no
reachable approver — maps to `'cancelled'`. If `url` is supplied it is
appended to the question body separated by a blank line so the approver
sees it on the card.

## Behavior guarantees

- `pastePlain` / `pastePgp` always release the host-interaction slot on
  resolution, whether by submit, cancel, or timeout.
- Bad input to `pastePgp` (non-PGP message, decrypt failure, validator
  rejection) never resolves the promise — it re-prompts inside the same
  slot. The only terminal reasons are `'submitted'`, `'cancelled'`, and
  `'timeout'`.
- Pasted content delivered to an active paste interaction is consumed
  by the router before any session-inbound write, so ciphertext and
  cleartext never land in the `messages_in` table.
- `pickFromButtons` does not write to the `pending_approvals` table.
  Its pending state is in-memory only — a process restart drops any
  in-flight pick (it never resolves; callers must handle that
  themselves if they care).
- The response handler installed by `pickFromButtons` returns `false`
  for any `questionId` it did not issue, so other modules' approvals and
  `ask_question` cards continue to dispatch normally.
- Imports of the module have no side effects beyond declaring symbols.
  Nothing runs at module load; the response handler is registered
  lazily on first call to `pickFromButtons`.

## Consumer usage

### Capture a PGP-encrypted credential paste

```ts
import { pastePgp } from './index.js';

registerHostCommand('/auth', async (ctx) => {
  if (ctx.args[0] !== 'import') return;
  const home = resolveGpgHomeForScope(ctx);    // caller's concern
  const r = await pastePgp({
    ctx,
    prompt: 'Paste the PGP-encrypted credential block, or type "cancel".',
    gpgHome: home,
    // Optional: the helper retries internally if validate rejects.
    validate: (pt) =>
      pt.includes('\n') ? null : 'Expected a multi-line credential block.',
  });
  if (r.reason !== 'submitted') {
    ctx.replyText(`Import ${r.reason}.`);
    return;
  }
  await storeCredential(r.text!);    // cleartext, already validated
  ctx.replyText('Imported.');
});
```

By the time the `await` returns, the helper has already absorbed any
non-PGP pastes, decrypt failures, or validator rejections by
re-prompting in place — the consumer only ever sees `submitted`,
`cancelled`, or `timeout`.

### Pick one of N

```ts
import { pickFromButtons } from './index.js';

const result = await pickFromButtons({
  session,
  agentName,
  title: 'Choose a region',
  question: 'Which region should we deploy to?',
  options: [
    { value: 'us-east-1', label: 'US East' },
    { value: 'eu-west-1', label: 'EU West' },
    { value: 'ap-south-1', label: 'AP South' },
  ],
});
if (result.reason === 'picked') deploy(result.value!);
```

### Confirm with an optional URL

```ts
import { confirmAction } from './index.js';

const r = await confirmAction({
  session,
  agentName,
  title: 'Confirm payment',
  question: 'Open the Stripe checkout to approve this charge?',
  url: 'https://checkout.stripe.com/c/pay/cs_…',
});
if (r === 'confirmed') /* proceed */;
```

### Helpers are imported, not on the context

The helpers are standalone functions and are **not** added to
`HostCommandContext`. Three of the four take a `Session`, not a command
context — they reach into approvals, which routes via
session / agent-group. Hanging them on `HostCommandContext` would
require duplicating the session argument or pulling it from `ctx` (which
is per-command, not per-session), and would grow the context object
without bound as future helpers ship. `beginInteraction` stays the only
helper on the context because every host command already has the
information needed to begin an interaction.

## Boundaries

**Not in scope:**

- Per-scope GPG homedir resolution. `pastePgp` takes `gpgHome` as a
  parameter; resolving the right home for a given credential scope is
  the calling module's concern.
- Any consumer-specific paste flow (`/auth import`, `/ssh add`,
  `/pem add`). Those live in the calling skill's command file and call
  these helpers.
- Approval timeouts for `pickFromButtons` / `confirmAction`. The
  approvals primitive does not expose a TTL; if the approver never
  clicks, the promise stays pending.
- Cancellation handles for `pastePlain` / `pastePgp` beyond the
  host-interaction timeout and the cancel keywords.
- A numbered-menu fallback for `pickFromButtons`. Today the helper is
  button-card only.

**Dependencies / required peers:**

- The host-interactions primitive (`ctx.beginInteraction` on
  `HostCommandContext`) for the paste helpers.
- The approvals primitive (`pickApprover`, `pickApprovalDelivery`) for
  the pick / confirm helpers.
- The permissions module, for the approvals primitive to resolve any
  approver at all — without it, `pickFromButtons` always returns
  `reason: 'declined'`.
- A delivery adapter mounted for the approver's DM channel kind.
- The crypto module (`gpgDecryptAt`, `isPgpMessage`,
  `normalizeArmoredBlock`) for `pastePgp`.

## Failure modes

| Situation                                                | Signal                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| User types a cancel keyword                              | `pastePlain` / `pastePgp` → `{ text: null, reason: 'cancelled' }`.     |
| Host-interaction slot times out                          | Paste helpers → `{ text: null, reason: 'timeout' }`.                   |
| Non-PGP paste / `gpg` decrypt fails / validator rejects  | `pastePgp` re-prompts in place with the error message; slot stays open. Terminal only on cancel or timeout. |
| No approver configured or no DM reachable                | `pickFromButtons` → `{ value: null, reason: 'declined' }`; no user-visible message. |
| Delivery adapter throws while sending the card           | Same as above — `reason: 'declined'`; error logged.                    |
| Approver clicks a value not in the supplied `options`    | `reason: 'declined'`; warning logged.                                  |

## Extension points

- Result types use discriminated `reason` literals, so new outcomes can
  be added without breaking exhaustive consumers (TypeScript flags the
  missing branch).
- `pickFromButtons` accepts an arbitrary `options` array, so future
  helpers (e.g. "rate 1–5") can be built as one-liners over it.
- `gpgHome` is a path parameter, so credential-storage redesigns
  (per-scope vs. global homedir) don't touch the helpers.
- `validate` is a hook, not a schema — consumers can layer arbitrary
  acceptance logic onto a paste capture.
</content>
</invoke>

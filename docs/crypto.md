# Crypto

## Summary

A host-side primitive that provides two cryptography surfaces other modules
compose against: AES-256-GCM at-rest encryption with key-rotation support, and
per-scope GPG keypair management for chat-based credential exchange. The AES
backend turns a plaintext string into a self-describing `enc:…` ciphertext and
back. The GPG surface manages one keypair per "scope" (an arbitrary string
namespace, typically an agent-group id) so a user can encrypt a secret with the
agent's public key and paste the result into chat without the cleartext ever
touching the wire.

The module is a pure primitive — it owns no data locations, opens no sockets,
and registers no commands. Consumers choose where keys live, when to
initialize, and what scopes mean. Importing the module is side-effect free; it
performs no IO until a caller initializes it.

## Capabilities

- Encrypt and decrypt strings with a single AES-256-GCM key stored as a file
  at a caller-chosen path.
- Detect whether a ciphertext was produced by the currently loaded key
  (`isCurrentKey`) and re-wrap a value with the current key (`reEncrypt`),
  enabling key rotation without losing existing data.
- Manage one GPG keypair per `scope` string under a caller-chosen base
  directory, with automatic generation on first use.
- Export a scope's ASCII-armored (or raw binary) public key to show the user.
  If the key has aged past its configured max age, it is regenerated on export;
  decryption of older ciphertexts is unaffected until the key material is
  replaced.
- Decrypt PGP-armored messages addressed to a scope's keypair without ever
  consulting the key's expiry.
- Detect whether a chat payload contains a PGP message and normalize armored
  blocks the user pasted (whitespace tolerance while preserving the mandatory
  blank line after the BEGIN header).
- Degrade cleanly when `gpg` is not installed: `isGpgAvailable()` lets the
  consumer branch instead of crashing.

## Public contract

All symbols are exported from `src/modules/crypto/index.js`.

### Lifecycle

```ts
function initEncryption(keyPath: string): void;
function initGpg(baseDir: string, maxAgeDays?: number): void;
```

- `initEncryption(keyPath)` loads or generates the 32-byte random AES key at
  `keyPath` (mode `0600`), creating the parent directory if missing. Must be
  called once before `encrypt` / `decrypt` / `reEncrypt` or `getSecretBackend`.
  There is no default path — the caller picks where the key lives.
- `initGpg(baseDir, maxAgeDays?)` records the base directory under which
  per-scope GPG homedirs live (`{baseDir}/{scope}/.gnupg/`) and the default key
  max age. Required before any of the scope-only `gpg.*` convenience functions
  are called; the path-explicit primitives (`ensureGpgKey`, `exportPublicKey`,
  `gpgDecrypt`, etc.) do not require `initGpg` since they take `baseDir` as
  their first argument.

### AES surface

```ts
const ENC_PREFIX = 'enc:';

interface SecretBackend {
  encrypt(plaintext: string): string;
  decrypt(value: string): string;
  isCurrentKey(value: string): boolean;
}

class AesSecretBackend implements SecretBackend {
  constructor(key: Buffer);                                  // raw 32-byte key
  static fromKeyFile(keyPath: string): AesSecretBackend;     // load or generate
  get keyHash(): string;                                     // first 16 hex chars of SHA256(key)
}

function getSecretBackend(): AesSecretBackend;
function encrypt(plaintext: string): string;
function decrypt(value: string): string;
function reEncrypt(value: string): string;
```

- Ciphertext format:
  `enc:aes-256-gcm:{keyHash16}:{iv_b64}:{tag_b64}:{ct_b64}`.
- `decrypt` passes through any string that does not start with `enc:` — it is
  safe to call on potentially-plaintext values.
- `decrypt` throws if the ciphertext's `keyHash16` does not match the loaded
  key (`"Encryption key mismatch …"`). This is the signal consumers use to
  detect rotation.
- `isCurrentKey(value)` returns `true` only for encrypted values wrapped with
  the currently loaded key; `false` for plaintext and for values encrypted
  with a different key.
- `reEncrypt(value)` decrypts then re-encrypts. On a plaintext input it is
  equivalent to `encrypt(value)`.
- `getSecretBackend()` throws if called before `initEncryption()`.

### GPG surface — path-explicit primitives

```ts
const DEFAULT_KEY_MAX_AGE_DAYS = 90;

interface GpgKeyMeta {
  createdAt: string;     // ISO timestamp
  maxAgeDays: number;
}

function isGpgAvailable(): boolean;
function gpgHome(baseDir: string, scope: string): string;
function ensureGpgKey(baseDir: string, scope: string, maxAgeDays?: number): void;
function exportPublicKey(baseDir: string, scope: string): string;
function exportPublicKeyBinary(baseDir: string, scope: string): Buffer;
function gpgDecrypt(baseDir: string, scope: string, ciphertext: string): string;
function gpgDecryptAt(home: string, ciphertext: string): string;
function getKeyMeta(baseDir: string, scope: string): GpgKeyMeta | null;
function isKeyExpired(baseDir: string, scope: string): boolean;
function isPgpMessage(text: string): boolean;
function normalizeArmoredBlock(block: string): string;
```

- Each scope gets its own GPG homedir at `{baseDir}/{scope}/.gnupg/`, created
  with mode `0700` on first `ensureGpgKey`. The keypair is RSA-2048 / RSA-2048,
  no passphrase (`%no-protection`), and no expiry inside GPG itself
  (`Expire-Date: 0`) — expiry is tracked in `key-meta.json` inside the homedir,
  not in the key material. The key carries `Name-Real: nanoclaw` and
  `Name-Email: {scope}@nanoclaw.local`.
- `ensureGpgKey` is idempotent: it generates a key only if one is not already
  present.
- `exportPublicKey` checks `key-meta.json`; if the key is older than its
  recorded `maxAgeDays` the entire homedir is removed, a fresh keypair is
  generated, and the new public key is exported. `exportPublicKeyBinary`
  returns the raw (non-armored) public key as a `Buffer` with the same expiry
  behavior — useful for callers that need to embed the key elsewhere (e.g. in a
  URL).
- `gpgDecrypt(baseDir, scope, ciphertext)` resolves the homedir from
  `baseDir` + `scope`. `gpgDecryptAt(home, ciphertext)` takes an explicit
  GNUPGHOME directory for callers that own the homedir path directly. Neither
  checks expiry — existing data is never locked out by an age policy.
- `isKeyExpired` returns `false` if there is no metadata file (legacy keys are
  treated as non-expired).
- `isPgpMessage(text)` returns `true` iff `text` contains the literal
  `-----BEGIN PGP MESSAGE-----` marker.
- `normalizeArmoredBlock(block)` trims whitespace from each line and drops
  empty lines, *except* the mandatory blank line immediately following a
  `-----BEGIN …-----` header — that one is preserved so the block remains a
  valid armored payload.

### GPG surface — scope-only convenience

```ts
const gpg: {
  ensure(scope: string, maxAgeDays?: number): void;
  export(scope: string): string;
  exportBinary(scope: string): Buffer;
  decrypt(scope: string, ciphertext: string): string;
  expired(scope: string): boolean;
  meta(scope: string): GpgKeyMeta | null;
  home(scope: string): string;
};
```

Each call routes to the matching path-explicit primitive using the `baseDir`
recorded by the most recent `initGpg(baseDir)`. Throws
`"GPG not initialized — call initGpg(baseDir) first"` if `initGpg` has not been
called.

## Behavior guarantees

- The AES backend is keyed by the file at `keyPath`. Two processes pointing at
  the same key file produce interoperable ciphertexts; two processes with
  different key files do not.
- `encrypt` is non-deterministic: a fresh 12-byte IV is generated for every
  call. Two encryptions of the same plaintext yield different ciphertexts.
- A ciphertext carries the first 16 hex chars of `SHA256(key)` in cleartext as
  `keyHash16`. This is intended for rotation detection only — it is not a
  secret and not part of the AEAD computation.
- Decrypting a ciphertext encrypted with a different key throws on the
  `keyHash16` mismatch before any GCM tag check, so the failure mode is a clear
  "key mismatch" message rather than a GCM authentication failure.
- GPG key expiry affects `exportPublicKey` / `exportPublicKeyBinary` only;
  `gpgDecrypt` always works regardless of age. Regeneration on export wipes the
  homedir, so once a key is expired-and-exported, prior ciphertexts for that
  scope can no longer be decrypted.
- The module performs no IO until a caller initializes it. The module owns no
  default paths — any `data/` location it uses is one the caller chose and
  passed in.

## Consumer usage

### AES at-rest store

```ts
import { initEncryption, encrypt, decrypt, reEncrypt } from '../crypto/index.js';

initEncryption('data/credentials/encryption-key');

const stored = encrypt(secretToken);          // enc:aes-256-gcm:…
const loaded = decrypt(stored);               // round-trips

const backend = getSecretBackend();
if (!backend.isCurrentKey(stored)) {
  const rotated = reEncrypt(stored);          // re-wrap with current key
  // persist `rotated`
}
```

### Per-scope GPG (path-explicit)

```ts
import {
  isGpgAvailable, ensureGpgKey, exportPublicKey, gpgDecrypt,
} from '../crypto/index.js';

if (!isGpgAvailable()) throw new Error('gpg binary not installed');

const base = 'data/credentials/gpg-home';
const scope = agentGroupId;

ensureGpgKey(base, scope);
const armoredPublic = exportPublicKey(base, scope);
// show armoredPublic to user, they paste back a PGP MESSAGE block
const plaintext = gpgDecrypt(base, scope, pgpMessageFromChat);
```

### Per-scope GPG (scope-only convenience)

```ts
import { initGpg, gpg, isPgpMessage } from '../crypto/index.js';

initGpg('data/credentials/gpg-home');

gpg.ensure(scope);
ctx.replyText(`Encrypt against:\n\n${gpg.export(scope)}`);

if (isPgpMessage(inboundText)) {
  const plain = gpg.decrypt(scope, inboundText);
}
```

## Boundaries

**Not in scope:**

- Choosing where AES keys or GPG homedirs live. The module exposes
  `initEncryption(keyPath)` and `initGpg(baseDir)` and writes nothing until
  called. There is no fallback to a built-in default location.
- Key rotation policy. The module exposes `isCurrentKey` and `reEncrypt` so a
  consumer can implement rotation; it does not decide when to rotate or which
  records to walk.
- Backend selection (KMS, Vault, HSM). `SecretBackend` is an interface; adding
  a non-AES backend is its own task.
- Passphrase-protected GPG keys. Generated keys carry `%no-protection` by
  design — the homedir's filesystem permissions are the only access control.
- Encrypting binary data through the AES surface. The AES primitives accept and
  return strings; callers that need binaries must base64-encode first.
- Cross-process locking on the AES key file. The file is read once at
  `initEncryption` and held in memory.
- Container-side use. This module is host-only; container code receives
  plaintext or ciphertext via the session DBs and does not link against it.

**Dependencies / required peers:**

- The `gpg` binary in `PATH`. `isGpgAvailable()` reports whether it is
  reachable; GPG primitives throw `execFileSync` errors otherwise.
- Node's built-in `node:crypto` for AES (no npm dependency).

## Failure modes

| Situation                                                       | Signal                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `encrypt` / `decrypt` / `getSecretBackend` before `initEncryption` | Throws `"Encryption not initialized — call initEncryption() first"`.            |
| `gpg.*` (convenience) before `initGpg`                          | Throws `"GPG not initialized — call initGpg(baseDir) first"`.                       |
| `decrypt` on a value with a different key's `keyHash16`         | Throws `"Encryption key mismatch — value was encrypted with a different key"`.      |
| `decrypt` on a malformed `enc:` value                           | Throws `"Malformed encrypted value"`.                                               |
| `new AesSecretBackend(key)` with a non-32-byte key              | Throws `"Encryption key must be 32 bytes, got N"`.                                  |
| GPG binary missing                                              | `isGpgAvailable()` returns `false`; GPG primitives throw on `execFileSync` failure. |
| GPG key expired and `exportPublicKey` called                    | Homedir wiped, fresh keypair generated, new public key returned; logged at `info`.  |
| `getKeyMeta` on a scope without metadata                        | Returns `null`; `isKeyExpired` treats this as non-expired.                          |

## Extension points

- `SecretBackend` is exported as an interface — additional backends can
  implement it without changing the convenience-wrapper signatures.
  `getSecretBackend()` is wired to the AES singleton; a backend-pluggability
  layer would build on this interface.
- The `gpg` convenience object is a plain record; new scope-only operations can
  be added without changing the path-explicit primitives.
- `DEFAULT_KEY_MAX_AGE_DAYS` is exported so consumers can reference the same
  constant rather than hardcoding `90`.

## Test coverage

- AES: round-trip; non-determinism (different IV per call); passthrough of
  non-`enc:` values; six-part ciphertext shape with 16-char `keyHash16`;
  `keyHash16` mismatch detection; malformed-value rejection; invalid key length
  rejection; `isCurrentKey` true only for own-key ciphertexts; `reEncrypt`
  round-trip.
- AES key file: generated on first use with 64 hex chars (32 bytes); reloaded
  from the same path produces an interoperable backend (cross-decrypt).
- GPG (gated on `isGpgAvailable`): keypair generation idempotent; custom
  `maxAgeDays` honored; per-scope homedirs isolated (scope A cannot decrypt
  scope B's payload); public key export round-trips through real
  encrypt/decrypt; expiry triggers regeneration on export only, not on decrypt;
  `gpgDecrypt` works regardless of expiry and throws on invalid ciphertext;
  `isPgpMessage` and `normalizeArmoredBlock` detection/normalization;
  `getKeyMeta` / `isKeyExpired` legacy (no-metadata) handling.
- Lifecycle: calling AES/GPG primitives before their `init` throws the
  documented error string.

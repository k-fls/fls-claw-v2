# SSH Auth

The host-side SSH subsystem. It lets a container open SSH connections to
remote servers without ever holding a password or a private key. The host
owns the secrets, authenticates the connection, and hands the container a
pre-authenticated multiplexing socket. The container drives `ssh`, `scp`,
and `rsync` over that socket; the key material never crosses the mount.

The module owns:

- two credential providers (`ssh` and `pem-passwords`) layered on the
  credentials substrate,
- an `SSHManager` that runs and tracks OpenSSH ControlMaster connections,
- a host-key verification + trust-on-first-use (TOFU) pinning model,
- a random-temp-password connect-time isolation model,
- four `/ssh/*` host-rpc endpoints the container calls,
- a per-scope socket directory bind-mounted into every container,
- the `/ssh` and `/pem` host commands for the human operator, and
- a per-alias pending-request queue so an agent that needs a credential
  can ask, and be notified asynchronously when the operator provides it.

All public symbols are exported from `src/modules/ssh-auth/index.ts`.
Importing that barrel self-registers the two credential providers, builds
the process-singleton `SSHManager`, registers the `/ssh` host-rpc handler,
and registers the `/ssh` + `/pem` host commands.

## Why host-rpc, not the credential proxy

SSH does not route through the credential proxy. The proxy intercepts a
container's *outbound* internet traffic and injects credentials into HTTP
requests; it has no place to put an SSH key. SSH is the inverse pattern:
the container reaches *inward* to the host over [host-rpc](host-rpc.md),
asks the host to stand up an authenticated transport, and then uses a
local socket the host populated. The proxy and the SSH subsystem are
siblings on top of the same credential store, not layers of one another.

## Credentials and scoping

Two providers are registered on the [credentials](credentials.md)
substrate:

- **`ssh`** — one entry per alias. The encrypted value carries the secret
  (password or private key). The plaintext `authFields` carry the
  connection metadata (`host`, `port`, `username`) and, for keys, the
  derived `publicKey` and the pinned `hostKey`.
- **`pem-passwords`** — passphrases used to strip encryption from a PEM at
  registration time. These are never surfaced in a manifest.

The auth method (`password` or `key`) is **not** stored in plaintext. It
is encoded as a prefix on the encrypted value (`password:…` / `key:…`).
Anyone with file access but no decryption key cannot tell whether an alias
is a password or a key credential. `sshToCredential` / `sshFromCredential`
convert between the typed `SSHCredentialMeta` shape and the generic
`Credential` envelope, applying and stripping that prefix.

Aliases are validated against `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`, max 60 chars.

Credentials are stored against a `CredentialScope` derived from the agent
group's folder. At connect time the manager resolves the alias against the
caller's own scope first; if absent, it falls back to the group's
configured credential source, but only after a **bilateral access check**
(`canAccess`) confirms the borrow is permitted. This is the standard
grant/borrow path of the credentials substrate, applied to SSH aliases.

### Manifest

The `ssh` provider publishes a JSONL manifest so the agent can discover
which aliases exist without ever seeing a secret. Each line carries
`provider`, `name`, `credScope`, `host`, `port`, `username` — and
deliberately omits `publicKey` and `hostKey`. The manifest is copied into
the group folder at `credentials/manifests/ssh.jsonl`, visible in the
container at `/workspace/group/credentials/manifests/ssh.jsonl` (borrowed
aliases appear under `credentials/borrowed/ssh.jsonl`). The
`pem-passwords` provider publishes an empty manifest.

## ControlMaster lifecycle

A connection is an OpenSSH ControlMaster process the host spawns and
detaches. Its Unix-domain control socket lives under a per-scope
directory; the container multiplexes new channels over that socket
instead of authenticating itself.

### Socket paths

```
/tmp/nanoclaw/ssh/<sha256(scope)[:16]>/<alias>.sock     (host)
/ssh-sockets/<alias>.sock                                (container)
```

The host path is hashed by scope so socket directories don't leak group
folder names, and the container path is decoupled from it entirely — the
container only ever knows `/ssh-sockets/<alias>.sock`. The per-scope host
directory is created `0700` and bind-mounted read-write at `/ssh-sockets`
inside every container of that scope (registered as an agent-group
contribution; see [agent-group-contributions](agent-group-contributions.md)).
The directory is created eagerly at contribution time so the bind mount
succeeds even before the group's first SSH call.

### connect()

`connect(scope, alias, { timeout?, pinAllowed })`:

1. **Reuse.** If a live connection exists for `(scope, alias)`, return it.
   Liveness is an `ssh -O check` against the socket; a dead socket is
   removed and rebuilt.
2. **Serialization.** Concurrent connects for the same `(scope, alias)`
   await a single in-flight promise — no duplicate ControlMaster races.
3. **Resolve** the credential (own scope, then borrow source).
4. **Verify the host key** (below). On mismatch, throw before any process
   spawns.
5. **Spawn** the ControlMaster:
   - `ControlMaster=yes`, `ControlPath=<socket>`, `ControlPersist=1800`
     (idle connections auto-close after 30 minutes).
   - `-F /dev/null` so no ambient SSH config leaks in.
   - `ForwardAgent=no`; agent forwarding is never enabled.
   - `ServerAliveInterval=30` / `ServerAliveCountMax=3` keepalives.
   - `StrictHostKeyChecking` is `yes` when a verified key line is in hand,
     `no` when the alias is `hostKey: '*'` (verification bypassed), and
     `accept-new` otherwise.
   - `UserKnownHostsFile` points at a temp file holding only the verified
     key line, or `/dev/null` when none.
6. **Poll** for the socket file to appear (100 ms interval, bounded by
   `timeout + 2 s`). If the SSH process exits before the socket appears,
   stop early and classify the failure from stderr — `auth_rejected`,
   `connection_refused`, or `timeout`.
7. On success, record the connection and return a `ControlMasterConnection`
   (alias, host, port, username, socket path, scope, host-key action and
   fingerprint).

### disconnect() / disconnectAll()

`disconnect(scope, alias)` issues `ssh -O exit` against the socket, unlinks
the socket file, and drops the tracking entry. `disconnectAll(scope)` tears
down every connection for a scope and removes the scope's socket directory.
Connections are also torn down automatically when a container exits — the
module registers a container-lifecycle observer that calls
`disconnectAll` and prunes that session's pending requests.

`startupSweep()` removes the entire `/tmp/nanoclaw/ssh` tree on host boot,
discarding sockets orphaned by a previous run.

## Connect-time secret isolation

The security model keeps the actual password or private key out of the SSH
process environment. The only secret in that environment is a **random
temporary password** (`tp`), 20 random bytes hex-encoded, regenerated on
every connect. `tp` on its own is worthless; it has value only in
combination with temp files that exist for the duration of the spawn and
are deleted the instant the socket appears.

- **Password auth.** The real password is encrypted with `openssl
  enc -aes-256-cbc -pbkdf2` under `tp` and written into a short askpass
  script. OpenSSH runs the script (via `SSH_ASKPASS` with
  `SSH_ASKPASS_REQUIRE=force`); the script decrypts the password using
  `tp` from the environment and feeds it to SSH. The cleartext password
  never lands on disk and never appears in the process's argv or env.
- **Key auth.** The private key is written to a temp PEM and re-encrypted
  with `tp` as its passphrase via `ssh-keygen -p`. The askpass script just
  echoes `tp`, so OpenSSH can decrypt the key in-process. The original key
  never sits unprotected on disk.

In both cases the temp directory (askpass script, encrypted material,
known_hosts) is removed **immediately** after the poll loop ends — whether
the socket came up or the connect failed. After that point `tp` decrypts
nothing, because the files it was paired with are gone. The container,
which only ever sees the resulting socket, never has access to any of it.

## Host-key verification

`verifyHostKey(alias, meta, credScope, pinAllowed)` decides what known_hosts
line (if any) to feed the ControlMaster, and returns the action taken:

- **`ignored`** — alias is `hostKey: '*'`. Verification is skipped
  entirely; the connection spawns with `StrictHostKeyChecking=no`.
- **`matched`** — the alias has a pinned `hostKey`. The host is scanned
  with `ssh-keyscan` (`ed25519,rsa`, ed25519 preferred). If the stored
  value is a fingerprint, every scanned key's fingerprint is compared
  against it; if it's a raw key line, the scanned keys are matched by key
  identity (type + key data, host field stripped). A match returns that
  key line. **No match throws `SSHHostKeyMismatchError`** and the connect
  is refused.
- **`pinned`** — no key stored yet and `pinAllowed` is true (TOFU). The
  scanned ed25519 key is pinned into the credential store on a
  first-writer-wins basis and used for this connection.
- **`unverified`** — no key stored and `pinAllowed` is false. The scanned
  key is used for this one connection but not persisted.

Verification is **fail-closed**: if `ssh-keyscan` returns no keys and the
alias is not `hostKey: '*'`, the connect is refused rather than trusting
whatever appears on the wire. This closes the attack where an adversary
suppresses the keyscan probe to slip an attacker-controlled key in on
first contact.

`connect()` always passes `pinAllowed: true`, so the first agent-driven
connection pins. The `/ssh test` command passes the operator's `pin` flag,
letting an operator probe a host without committing a pin.

## Host-rpc endpoints

The container reaches the host at `CLAW_HOST_RPC_URL` (injected as an
agent-group contribution). All four endpoints are claimed under the `/ssh`
prefix; [host-rpc](host-rpc.md) authorizes the caller by source IP and
hands the handler a non-null `ContainerScope`, which the SSH handler
resolves to the agent group's folder-derived `GroupScope`. A container can
therefore only ever act on its own scope's credentials and sockets.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/ssh/request-credential` | Generate a keypair, or record a pending ask + notify the operator |
| POST | `/ssh/connect` | Establish a ControlMaster; return usage instructions |
| POST | `/ssh/disconnect` | Tear down a ControlMaster |
| GET  | `/ssh/connections` | List active connections for the scope |

### POST `/ssh/request-credential`

Body: `alias`, `mode` (`generate` | `ask`), `connection_host`,
`connection_port?`, `connection_username?`.

- If the alias already exists, returns `{ status: 'ok', publicKey? }`.
- **`generate`** — generates an ed25519 keypair on the host, stores it as a
  key credential (with the supplied connection metadata, `hostKey: null`),
  and returns the public key for the operator to install in the remote
  `authorized_keys`. Requires `connection_username` and `connection_host`.
- **`ask`** — records a pending request keyed by alias for the calling
  session, DMs the operator a `/ssh add …` hint, and returns
  `{ status: 'pending' }`. If the pending queue is at its cap the request
  is suppressed (`{ status: 'suppressed' }`).

### POST `/ssh/connect`

Body: `alias`, `timeout?`. Calls `SSHManager.connect` with
`pinAllowed: true`. On success returns `{ status: 'ok', alias, usage }`
where `usage` is the ready-to-paste `ssh`/`scp`/`rsync` command lines
pointing at `/ssh-sockets/<alias>.sock`. A TOFU pin triggers an operator
DM with the pinned fingerprint. A host-key mismatch returns
`{ status: 'error', code: 'host_key_mismatch' }` and DMs the operator a
`/ssh reset-host …` hint. Other `SSHError`s return as
`{ status: 'error', code, message }`.

### POST `/ssh/disconnect`

Body: `alias`. Tears down the ControlMaster and returns `{ status: 'ok' }`.

### GET `/ssh/connections`

Returns `{ status: 'ok', connections: [{ alias, host, port, username }] }`
for the calling scope.

## Pending requests

When an agent asks for a credential it doesn't have (`mode: 'ask'`), the
request is parked in a per-scope file at
`<scopeDir>/ssh.pending.json`, keyed by alias. Each alias maps to a list
of `{ sessionId, ts }` tuples, because the same alias may be requested
independently from several sessions, and each must hear back when the
operator fulfills it.

- Requests are idempotent per `(alias, sessionId)` — a re-ask refreshes the
  timestamp rather than duplicating.
- Entries older than 1 hour are pruned on every access. The queue is
  capped at 10 tuples per scope; once full, new asks are suppressed and the
  operator is warned to resolve or `/ssh clear-pending`.
- When `/ssh add <alias>` lands, all parked entries for that alias are
  drained and each live session is notified that the credential is ready.
- When a container exits, that session's parked entries are dropped (they
  can no longer be delivered).

## Operator commands

Both commands are agent-scoped host commands: they act on the agent group
the operator is conversing with, resolving its folder-derived scopes.
Secrets are never typed in the clear — `/ssh add` and `/pem add` accept an
inline GPG/PEM block, or prompt for a PGP-encrypted paste using the
per-scope GPG keyring.

### `/ssh`

```
/ssh add <alias> user@host[:port] [hostKey=*|<fingerprint>] [pem=<id>] [GPG/PEM block]
/ssh delete <alias>
/ssh gen <alias> user@host[:port]
/ssh test <alias> [pin] [timeout=N]
/ssh reset-host <alias> [hostKey=*|<fingerprint>]
/ssh clear-pending
```

- **add** — register a credential under `alias`. The secret may be inline
  (a GPG message, OpenSSH/RSA private key) or pasted via the encrypted-paste
  prompt. A private key is accepted only if it is GPG-wrapped or
  passphrase-protected; a raw unencrypted key is rejected. Passphrase-
  protected keys are stripped using a stored `pem-passwords` entry
  (`pem=<id>`, or any stored passphrase if no hint is given) and the public
  key is derived. Anything that isn't a PEM is treated as a password.
  `hostKey=*` disables verification for the alias; `hostKey=<fingerprint>`
  pins a specific key. Storing fulfills any pending agent requests for the
  alias.
- **delete** — disconnect any live ControlMaster and remove the alias.
- **gen** — generate an ed25519 keypair on the host and print the public
  key to install in the remote `authorized_keys`.
- **test** — open and immediately close a connection to verify it works,
  reporting the host-key fingerprint and action. `pin` commits a TOFU pin;
  `timeout=N` overrides the connect timeout.
- **reset-host** — clear or re-set the pinned host key. With no argument the
  next connection re-verifies via TOFU; `hostKey=*` disables verification;
  `hostKey=<fingerprint>` pins a new key (used to accept a legitimately
  rotated host key after a mismatch).
- **clear-pending** — drop all parked credential requests for the scope.

### `/pem`

```
/pem add <id> [GPG block]
/pem delete <id>
```

Register or remove a passphrase used to decrypt encrypted PEM keys at
`/ssh add` time. The passphrase is provided inline as a GPG block or via
the encrypted-paste prompt; it is never echoed and never surfaced in a
manifest.

## Container skill and MCP tools

The container ships an `ssh` skill describing the workflow, plus three MCP
tools that call the host-rpc endpoints over `CLAW_HOST_RPC_URL`:

- **`ssh_request_credential`** — `generate` a keypair or `ask` the operator.
- **`ssh_connect`** — establish a connection; returns the usage lines.
- **`ssh_disconnect`** — tear a connection down.

The agent discovers existing aliases from the JSONL manifests and never
handles secrets. After `ssh_connect`, it runs standard tools against the
control socket. Because the host already verified the host key and
authenticated the transport, the agent must **not** add
`StrictHostKeyChecking`; for `ssh` the destination argument is ignored
(convention: `_`), while `scp`/`rsync` still need `user@host` because it
determines the remote path:

```bash
ssh   -o ControlPath=/ssh-sockets/prod-db.sock _ ls /tmp
scp   -o ControlPath=/ssh-sockets/prod-db.sock local.txt deploy@prod-db.example.com:/remote/
rsync -e "ssh -o ControlPath=/ssh-sockets/prod-db.sock" src/ deploy@prod-db.example.com:/dest/
```

## Operator notifications

Asynchronous events (a credential is needed, a host key was pinned, a host
key mismatched) are surfaced to a human by resolving the agent group's
approver (scoped admin → global admin → owner), opening or reusing that
user's DM messaging group, and delivering the message directly through the
channel adapter. Delivery is best-effort: if no approver is reachable the
notification is dropped with a warning.

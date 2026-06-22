# MITM proxy — browser (NSS) trust

Scope: how the agent container makes Chromium (and, if installed,
Firefox) trust the MITM CA so headless browsing through `agent-browser`
/ Playwright doesn't blow up with `NET::ERR_CERT_AUTHORITY_INVALID`.

## Why a second store

Linux has two separate trust universes:

| Store | Path | Consumers |
|---|---|---|
| System CA (OpenSSL) | `/etc/ssl/certs/ca-certificates.crt` | curl, git, wget, apt, Node (`SSL_CERT_FILE`), Bun, anything linked against OpenSSL |
| NSS shared SQL DB | `$HOME/.pki/nssdb/cert9.db` | Chromium, Chrome, Edge on Linux (and Firefox per-profile under `~/.mozilla/firefox/<prof>/`) |

The two are independent. Writing to the system store does **not** make
Chromium trust the cert, and vice versa. The agent container needs
both.

## What the entrypoint does

`container/entrypoint.sh` runs two install blocks when the mitm-proxy
observer mounts the host CA at `$MITM_CA_PATH`:

1. **System store** — `update-ca-certificates` (or a manual concat
   fallback) regenerates `/etc/ssl/certs/ca-certificates.crt`. Covers
   curl / git / Node etc. inside the container.
2. **NSS store** — if `certutil` is on `$PATH` (provided by
   `libnss3-tools` in the Dockerfile):
   1. `mkdir -p /home/node/.pki/nssdb`
   2. `certutil -N --empty-password -d sql:$NSS_DIR` if no `cert9.db`
      exists yet (first-spawn case).
   3. `certutil -A -d sql:$NSS_DIR -t "C,," -n "nanoclaw-mitm-ca" -i $MITM_CA_PATH`
      to add (or overwrite) the cert.
   4. Under root-drop launch (uid 0 + `HOST_UID` set), `chown -R` the
      `.pki` tree to `HOST_UID:HOST_GID` so the dropped-privilege
      agent can read it.

All steps swallow errors (`|| true`). Browser trust is a soft
capability — losing it shouldn't take the container down when the rest
of the stack is still functional. The host-side test in
`src/modules/mitm-proxy/e2e.test.ts` is the safety net that catches
silent regressions.

## Trust string `"C,,"` decoded

NSS trust attributes are three comma-separated columns:
`<ssl>,<smime>,<codesign>`. Each column is a string of single-letter
flags. We use:

- `C` in the SSL column — "Trusted CA to issue server certs."
- empty S/MIME and code-signing columns — explicitly **not** trusted
  for those uses. Defense-in-depth: an attacker who somehow swaps the
  CA bundle still doesn't get email-signing or executable-signing
  authority for free.

There is no `c` (the lowercase variant for client certs). If
container-side code ever needs the agent to be a TLS *client* against
mutual-TLS endpoints with the MITM CA, that's a separate flag and
should be added deliberately.

## Why nickname `nanoclaw-mitm-ca`

Single fixed nickname so:

- `certutil -A` is idempotent on respawn — it overwrites the existing
  entry rather than appending duplicates.
- The e2e probe's regex check (`^nanoclaw-mitm-ca\s+[CTPucwu]*C[CTPucwu]*,`)
  has a stable target to match against.

If the host ever rotates the MITM CA mid-session: the container is
killed and respawned on the next message (the host-side cert
generation isn't hot-reloadable), so the next entrypoint pass
overwrites with the new cert under the same nickname.

## Firefox

Not shipped in the base image (no `firefox-esr` in the Dockerfile). If
a user installs it through `install_packages`, Chromium-style global
trust does **not** carry over: Firefox stores trust per profile in
`~/.mozilla/firefox/<profile>/cert9.db`. Adding it is the same shape:

```bash
certutil -A -d "sql:$HOME/.mozilla/firefox/<profile>" -t "C,," \
  -n "nanoclaw-mitm-ca" -i "$MITM_CA_PATH"
```

If/when Firefox lands as a first-class container capability, fold this
into the existing NSS block by enumerating
`~/.mozilla/firefox/*/cert9.db` parents and running `certutil -A`
against each. The container-bootstrap observer doesn't need changes —
`MITM_CA_PATH` is already the right contract.

## Verifying inside a running container

```bash
# List trusted certs in the NSS DB
certutil -L -d sql:$HOME/.pki/nssdb

# Should show:
#   nanoclaw-mitm-ca                                             C,,

# Verify a hostname against the DB (Chromium does the equivalent at
# request time). Returns `Certificate is valid` on success.
certutil -V -d sql:$HOME/.pki/nssdb -n "nanoclaw-mitm-ca" -u L
```

For an end-to-end check from the agent's perspective, drive
`agent-browser` against an intercepted hostname and confirm the
response body — that exercises the full TLS handshake against the
forged cert through Chromium's NSS-backed verifier.

## Related code

| File | Role |
|---|---|
| [`container/Dockerfile`](../container/Dockerfile) | Installs `libnss3-tools` (provides `certutil`) |
| [`container/entrypoint.sh`](../container/entrypoint.sh) | NSS DB init + `certutil -A` block (env-gated on `MITM_CA_PATH`) |
| [`src/modules/mitm-proxy/observer.ts`](../src/modules/mitm-proxy/observer.ts) | Source of the `MITM_CA_PATH` env + CA bind-mount the entrypoint reads |
| [`src/modules/mitm-proxy/e2e-probe.ts`](../src/modules/mitm-proxy/e2e-probe.ts) | `nss` field on `ProbeResult` — `dbExists`, `listOutput`, `mitmCaTrusted` |
| [`src/modules/mitm-proxy/e2e.test.ts`](../src/modules/mitm-proxy/e2e.test.ts) | Live-container assertions that confirm NSS trust took |

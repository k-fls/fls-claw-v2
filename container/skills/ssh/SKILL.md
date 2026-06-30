# SSH Connections

You can connect to remote servers via SSH using pre-authenticated ControlMaster sockets. Credentials are managed by the host — you never see passwords or private keys.

## Available MCP Tools

### `ssh_request_credential`
Request credentials from the user:
- `mode: "generate"` — host generates an ed25519 keypair. Returns the public key for the user to install on the remote server.
- `mode: "ask"` — notifies the user to provide credentials via `/ssh add`. Returns `"pending"` — you'll receive an async message when fulfilled.

### `ssh_connect`
Establish a connection. Returns usage instructions with the ControlPath socket.

### `ssh_disconnect`
Tear down a connection when done.

## Discovering Available Credentials

Check the JSONL manifests in your group directory:

- **Own credentials:** `/workspace/group/credentials/manifests/ssh.jsonl`
- **Borrowed credentials:** `/workspace/group/credentials/borrowed/ssh.jsonl`

Each line is JSON:
```json
{"provider":"ssh","name":"prod-db","credScope":"main","host":"prod-db.example.com","port":22,"username":"deploy"}
```

## Usage After Connecting

After `ssh_connect` returns, use standard SSH commands with the ControlPath socket.

The connection is pre-authenticated via ControlMaster on the host — your commands multiplex over the existing socket. This means:
- **No `-o StrictHostKeyChecking=...` needed** — host key verification already happened on the host side before the socket was created. Adding it is unnecessary and misleading.
- **For `ssh`: the destination argument is ignored** — the socket already knows the user and host. You must still provide it syntactically, but any value works (convention: `_`).
- **For `scp`/`rsync`: `user@host` is required** — it determines the remote file path. Get `username` and `host` from the JSONL manifest or the `ssh_connect` response.

```bash
# Run a command (destination is ignored, use _ as placeholder)
ssh -o ControlPath=/ssh-sockets/prod-db.sock _ ls /tmp

# Copy files (user@host required for remote path)
scp -o ControlPath=/ssh-sockets/prod-db.sock local.txt deploy@prod-db.example.com:/remote/

# Rsync (user@host required for remote path)
rsync -e "ssh -o ControlPath=/ssh-sockets/prod-db.sock" src/ deploy@prod-db.example.com:/dest/
```

## Workflow

1. Check manifests for existing credentials
2. If needed, call `ssh_request_credential` to request new ones
3. Call `ssh_connect` to establish the connection
4. Use `ssh`/`scp`/`rsync` with the provided ControlPath
5. Call `ssh_disconnect` when done (optional — connections auto-close after 30min idle or when your session ends)

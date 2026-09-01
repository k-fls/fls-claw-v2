# Remove the containerized host runner

Every step is idempotent — safe to re-run.

## 1. Stop the containerized host

```bash
docker stop claw-host 2>/dev/null || true
```

The container runs with `--rm`, so stopping it removes it.

## 2. Delete the copied files

```bash
rm -rf dev/host-runner
rmdir dev 2>/dev/null || true
```

## 3. Remove the image and volumes

```bash
docker rmi claw-host:latest 2>/dev/null || true
docker volume rm claw-host-node-modules claw-host-pnpm-store 2>/dev/null || true
```

## 4. Restore the Mac-side host

The Mac tree's `node_modules` was never touched — the container shadowed it with a
volume — so the host starts as it did before:

```bash
launchctl bootin gui/$(id -u)/com.nanoclaw 2>/dev/null \
  || launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null \
  || true
```

If the install uses a slug-scoped launchd label, find it with
`launchctl list | grep -i nanoclaw` and load that one instead. For a dev-loop host, run
`pnpm run dev`.

Agent containers will again reach the host through Docker's port-forwarder, so host-rpc
and the credential proxy go back to rejecting them with
`unknown caller IP, rejecting callerIP="127.0.0.1"`.

# Host RPC

## Summary

Host RPC is a small HTTP server the host runs on the nanoclaw bridge
network so that containers can call the host directly for actions whose
effect lives on the host and don't fit the session-DB IO model.

It is the deliberate inverse of the session-DB rule. Normal traffic
between host and container flows only through the two session SQLite
files, and the credential proxy intercepts a container's *outbound*
internet traffic. Host RPC is the one place where a container reaches
*inward* on purpose: it sends an HTTP request to a handler registered
against a path prefix and gets a JSON response back.

Each feature that needs this registers a handler against a path prefix
and owns everything under it. The module itself ships no endpoints — it
is the substrate. Feature groups such as SSH connection management and
group OAuth interaction polling layer their own prefixes on top.

## Caller authorization

There are no tokens and no auth headers. A request is authorized purely
by its source IP.

When a request arrives, the server reads the socket's remote address
(stripping any IPv4-mapped IPv6 prefix) and resolves it against the
container-IP registry from the container-bootstrap module
(`lookupContainerIP`). That registry is the same map that records which
IP belongs to which running container's scope.

- If the IP can't be mapped to a registered container, the server
  replies `403 { ok: false, error: 'unknown-caller' }` **before any
  handler runs**.
- If it resolves, the server hands the handler a non-null
  `ContainerScope` identifying the owning agent group / session.

The handler signature enforces this: `scope` is a required, non-null
parameter, so a handler can never be invoked for an unauthorized caller.
A handler therefore always knows, with no further work, which container
is calling it.

## Prefix registry

Handlers self-register by importing the module and calling
`registerHostRpc(prefix, handler)`.

- A prefix must start with `/` and may contain `[a-zA-Z0-9._/-]`.
- A trailing slash is stripped at registration, so `/foo` and `/foo/`
  are equivalent and only one registration wins.
- Re-registering an existing prefix overwrites the prior handler and
  logs a warning.

Dispatch is **longest-prefix-match** and respects path segment
boundaries. A handler registered against `/foo` claims `/foo`, `/foo/`,
and `/foo/bar`, but not `/foobar`. A handler registered against the
root `/` matches everything. When two prefixes both match a path, the
longer one wins. The matched handler receives the full path and method
and decides its own sub-routing and method dispatch.

`listHostRpcHandlers()` returns the set of registered prefixes.

## Handler interface

```ts
type HostRpcHandler =
  (req: HostRpcRequest, scope: ContainerScope) => Promise<unknown> | unknown;

interface HostRpcRequest {
  method: string;   // uppercase HTTP method: 'GET', 'POST', ...
  path: string;     // full request path, e.g. '/ssh/connect'
  body: unknown;    // parsed JSON body, or undefined
  callerIP: string; // raw caller IP, for logging; prefer `scope`
}
```

- A handler's return value becomes the body of `{ ok: true, result }`
  with status 200.
- A thrown error becomes `{ ok: false, error: <message> }` with status
  500.
- Handlers may inspect `req.method` and `req.path` to route within their
  prefix.

## Wire format

- **Request** — any HTTP method. `Content-Type: application/json` is
  optional. The body is arbitrary JSON, capped at 1 MiB; an empty body
  is parsed as `undefined`.
- **Response** — always JSON:
  - `200 { ok: true, result }` — handler ran and returned.
  - `400 { ok: false, error: 'no-caller-ip' }` — no resolvable source
    address.
  - `403 { ok: false, error: 'unknown-caller' }` — source IP not a
    registered container.
  - `404 { ok: false, error: 'no-handler' }` — no prefix matched.
  - `400 { ok: false, error: 'invalid-json' }` — body was not valid
    JSON.
  - `413 { ok: false, error: 'body-too-large' }` — body exceeded 1 MiB.
  - `500 { ok: false, error: <message> }` — handler threw.

## Binding

The server binds to a host interface reachable from the nanoclaw bridge
but deliberately not exposed across other host interfaces. The bind
address is detected the same way the container args derive the proxy
bind host:

- **macOS / WSL / Docker Desktop** — `127.0.0.1`. There,
  `host.docker.internal` resolves to loopback inside the VM, so
  loopback is reachable from containers.
- **Bare-metal Linux** — the `docker0` bridge IPv4. Containers reach the
  host via `host.docker.internal` wired to `host-gateway`, which
  resolves to the docker0 bridge address. Binding there keeps the port
  reachable from containers without publishing it on every host
  interface. The address is taken from `os.networkInterfaces()`, falling
  back to parsing `ip addr show docker0` when docker0 is idle (no
  containers running), and ultimately to `127.0.0.1`.

`NANOCLAW_HOST_RPC_BIND` overrides the detected bind host.

## Port

The port is resolved in one leaf module so both the server and the
egress-lockdown allowlist agree on it without re-hardcoding. The egress
firewall must allow exactly this port.

- Default: `17381`.
- `NANOCLAW_HOST_RPC_PORT` overrides it.

`hostRpcPort()` returns the effective port; `DEFAULT_HOST_RPC_PORT` is
the default constant.

## Lifecycle

`startHostRpcServer({ port?, bind? })` binds the server and is started
explicitly after the bridge network is up; it throws if called while a
server is already running. Registration of handlers can happen before or
after start. `stopHostRpcServer()` closes the server and is idempotent.
The module registers a shutdown hook that stops the server cleanly.

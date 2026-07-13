# Credentials & External Services

Your outbound HTTPS goes through a host-side **credential proxy**. Real secrets live on the host and are swapped into your requests in flight — you never see or handle them. What you hold is always a **substitute**: a placeholder the proxy recognizes and replaces as the request leaves. For many providers a substitute is already published as an env var at startup, so you can just make the request.

- **Never ask the user for a raw API key, token, or password**, and never fabricate credential-setup steps. If a credential is missing, the host drives acquisition out-of-band.
- Where a tool or config needs a credential value, use the substitute (or a harmless placeholder) exactly where the real token would go — the swap happens in flight.
- On a `401`/`403` from a service whose credential should exist, don't retry blindly and don't ask for a raw key — report that the stored credential is missing or expired; the host handles re-authentication.

Run `/credentials` for the full flow (pulling a substitute with `get_credential`, binding it to an env var, error recovery). Run `/auth-providers` to teach the proxy about a service it doesn't already know.

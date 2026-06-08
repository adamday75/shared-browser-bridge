# shared-browser-bridge

Local shared-control browser bridge for a real visible Chrome session.

## What this is (and is not)

A small local Node service that attaches to a visible Chrome window and exposes a tiny HTTP API so agents (or scripts) can drive the same browser the user is looking at.

It is not a production web service, an auth system, or a remotely-deployed daemon. It is intentionally localhost-first and makes no attempt to be hardened for network exposure. The optional bearer token described below is a convenience guard for shared local environments — not a substitute for network-level isolation.

## Quickstart

```sh
# 1. Start Chrome with remote debugging enabled (Windows example)
chrome.exe --remote-debugging-port=9222

# 2. Start the bridge (stays bound to 127.0.0.1 by default)
node src/index.js

# 3. Check the bridge
curl http://127.0.0.1:7820/health
```

The bridge binds to `127.0.0.1:7820` by default. It will not accept connections from other machines unless you change `BRIDGE_HOST`.

## Configuration

All configuration is via environment variables. Defaults are safe for local use.

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | Host to bind. Keep this as `127.0.0.1` unless you know what you are doing. |
| `BRIDGE_PORT` | `7820` | Port to listen on. |
| `BRIDGE_API_TOKEN` | (unset) | Optional bearer token. See below. |
| `CDP_HOST` | `127.0.0.1` | Chrome DevTools Protocol host. |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port. |

## Optional API token

By default the bridge is open — no token required. Binding to `127.0.0.1` keeps it off the network, but any local process on the same machine can still call it.

If you run the bridge in an environment where other local processes you do not control might call it (e.g. a shared dev machine, a container with mapped ports), you can add a shared-secret guard:

```sh
BRIDGE_API_TOKEN=my-secret node src/index.js
```

Once set, every API request must include the token as a bearer header:

```sh
curl -H "Authorization: Bearer my-secret" http://127.0.0.1:7820/health
```

Without the header, or with the wrong token, the server returns `401`:

```json
{ "ok": false, "error": "invalid or missing bearer token" }
```

Token rules:
- Unset or empty → bridge behaves exactly as before (no auth check).
- Set to any non-empty string → all routes require a valid `Authorization: Bearer <token>` header.
- There is only one token (shared secret). No user accounts, no rotation logic.

## Thesis

People do not actually want a fake automation browser when they are already logged into the real one.
They want agents to use the browser they are already using, keep real session state, stay visible, and allow clean human takeover.

## V1

A Windows-hosted Node service that:
- attaches to real visible Chrome via CDP
- exposes a tiny local API
- supports goto / click / type / snapshot / tabs / url
- preserves real logged-in session state
- supports human interrupt and agent resume

## Why Windows-side browser

For this setup, the browser should live on the **Windows side**.
That is the whole point of the project:
- Chrome is real and visible on the Windows desktop
- login/session state is native and stable
- WSL/OpenClaw/other agents call into a local bridge instead of launching fake side browsers

## Windows vs WSL

The intended production setup is the **bridge running on Windows**, attached to the user's real visible Chrome via CDP. WSL agents call the bridge over localhost (which works because Windows and WSL share the loopback interface on WSL2).

From WSL, the bridge is reachable at `http://127.0.0.1:7820` without any extra configuration — WSL2's NAT forwards the loopback automatically.

Running the bridge from WSL against a local headless Chrome is a development/testing convenience for exercising the attach/launch logic — it is not the target setup.

## Docs

- `docs/BUILD_READY_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/REVIEW_WORKFLOW.md`

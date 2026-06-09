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
| `CDP_HOST` | `127.0.0.1` | Chrome DevTools Protocol host. Set to the Windows host IP when running the bridge from WSL. See below. |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port. |
| `CDP_ALLOW_REMOTE_LAUNCH` | (unset) | Set to `1` to allow Chrome launch fallback when `CDP_HOST` is not a local address. Off by default: launching a local Chrome when CDP_HOST points elsewhere would silently control a different browser than intended. |
| `TAKEOVER_POLL_INTERVAL_MS` | `2000` | How often the passive takeover poller checks for drift while ATTACHED (milliseconds). |

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
{ "ok": false, "code": "AUTH_FAILED", "error": "invalid or missing bearer token" }
```

Token rules:
- Unset or empty → bridge behaves exactly as before (no auth check).
- Set to any non-empty string → all routes require a valid `Authorization: Bearer <token>` header.
- There is only one token (shared secret). No user accounts, no rotation logic.

## Failure responses

All error responses share this shape:

```json
{ "ok": false, "code": "...", "error": "..." }
```

`code` is a short machine-readable identifier. `error` is a human-readable message. Responses from state-gated routes also include `controlState`.

### Error codes

| Code | HTTP status | Meaning |
|---|---|---|
| `AUTH_FAILED` | 401 | Token required but missing or wrong |
| `NOT_FOUND` | 404 | Route does not exist |
| `INVALID_INPUT` | 400 | Request body missing a required field or has invalid content |
| `BODY_TOO_LARGE` | 413 | Request body exceeds the 1 MB limit |
| `NOT_ATTACHED` | 503 | Bridge is not attached to Chrome; attach or recover first |
| `BRIDGE_ERROR` | 409 | Bridge is in ERROR state; call `POST /control/recover` |
| `PAUSED` | 409 | Bridge is paused; call `POST /control/resume` |
| `HUMAN_ACTIVE` | 409 | Human has the active control slot |
| `AGENT_ACTIVE` | 409 | An agent action is already in progress |
| `CDP_ERROR` | 503 | Chrome connection failed or lost during an action |
| `NO_PAGE_TARGET` | 409 | No open browser page tabs to act on |
| `PAGE_ACTION_ERROR` | 404/502/504 | Page action failed (element not found, navigation error, or timeout) |
| `STATE_CONFLICT` | 409 | State transition rejected; operation not allowed in current state, or concurrent race condition |
| `TARGET_DRIFT` | 409 | Observable browser target changed since the last agent baseline; pass `adoptCurrentTarget`, `adoptTargetId`, or `force` to resume |
| `MISSING_BASELINE` | 409 | Resume blocked because agent previously acted but no observable target baseline was recorded; pass `adoptCurrentTarget`, `adoptTargetId`, or `force` |
| `TARGET_NOT_FOUND` | 409 | `adoptTargetId` was passed but no open tab has that id; response includes `availableTargets` listing open tabs |
| `INTERNAL_ERROR` | 500 | Unexpected error in the bridge process |

### State-gated rejections

Page action routes (`/page/*`) reject when the bridge is not in a ready state. The response includes `controlState` so you can act on it without a separate `GET /control/state` call:

```json
{ "ok": false, "code": "PAUSED", "controlState": "PAUSED", "error": "bridge is paused; call POST /control/resume before issuing page actions" }
```

```json
{ "ok": false, "code": "NOT_ATTACHED", "controlState": "DETACHED", "error": "not attached to Chrome" }
```

Call `GET /control/state` at any time to inspect the full bridge state.

## Drift and recovery introspection

When `POST /control/resume` detects that the observable browser target changed since the last agent baseline, it returns `TARGET_DRIFT` with a structured `drift` object and an `availableTargets` list:

```json
{
  "ok": false,
  "code": "TARGET_DRIFT",
  "controlState": "PAUSED",
  "error": "observable browser target changed since the last agent baseline...",
  "drift": {
    "expectedTabId": "tab-1",
    "expectedUrl": "http://example.com",
    "expectedTitle": "Original Page",
    "currentTabId": "tab-2",
    "currentUrl": "http://other.com",
    "currentTitle": "Different Page"
  },
  "availableTargets": [
    { "id": "tab-2", "url": "http://other.com", "title": "Different Page" }
  ]
}
```

The `drift` fields reflect what the bridge recorded at the time of the last agent baseline (`expected*`) vs. what CDP reports now (`current*`). The `availableTargets` array lists all open page tabs at the moment of the check — use it to pick a specific target without a separate `GET /tabs` call.

**Focused-tab limitation:** CDP's HTTP `/json/list` surface does not expose which tab the human has focused. The bridge cannot detect tab-focus switches where the baseline tab is still open and at the same URL. Drift detection fires only when the first listed page target has a different id or URL than the stored baseline. To switch targets deliberately, use `GET /tabs` to see what is open and pass `adoptTargetId` on resume.

**How a client should react based on the blocking code:**

| Code | Meaning | Suggested action |
|---|---|---|
| `TARGET_DRIFT` | Browser tab or URL changed since agent baseline | Inspect `drift` and `availableTargets`; pass `{"adoptCurrentTarget":true}` to accept the new state, `{"adoptTargetId":"<id>"}` to pick a specific tab, or `{"force":true}` to resume without updating the baseline |
| `TARGET_NOT_FOUND` | `adoptTargetId` id not found among open tabs | Check `availableTargets` in the response for valid ids |
| `MISSING_BASELINE` | Agent previously acted but no observable baseline was recorded | Pass `{"adoptCurrentTarget":true}` to take the current tab as the new baseline, `{"adoptTargetId":"<id>"}` to pick a specific tab, or `{"force":true}` to resume unconditionally |
| `NO_PAGE_TARGET` | No open browser page tabs found | Open a page in Chrome, then call `POST /control/recover`; or pass `{"adoptCurrentTarget":true}` to accept the current target once a page is available |
| `CDP_ERROR` | Chrome connection lost | Check that Chrome is running with `--remote-debugging-port`; call `POST /control/recover` |
| `STATE_CONFLICT` | Wrong state for this operation | Call `GET /control/state` to check current state |

Parse `code`, not `error` — `code` is the machine-readable identifier to handle programmatically; the human-readable `error` string may change between versions.

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

The intended production setup is the **bridge running on Windows**, attached to the user's real visible Chrome via CDP. WSL agents call the bridge at `http://127.0.0.1:7820` — WSL2 forwards the Windows loopback automatically.

**Running the bridge from WSL (development mode):** If you run the bridge from WSL instead of Windows, `127.0.0.1:9222` may not reach Windows Chrome from WSL due to WSL2 network isolation. Use the Windows host IP from `/etc/resolv.conf`:

```bash
cat /etc/resolv.conf | grep nameserver | awk '{print $2}'
# e.g. 172.22.96.1

CDP_HOST=172.22.96.1 node src/index.js
```

This is a tested pattern from live usage. The bridge will refuse to launch a local Chrome as a fallback for a non-local `CDP_HOST` unless you explicitly set `CDP_ALLOW_REMOTE_LAUNCH=1` — that guard prevents silently controlling the wrong browser.

## Docs

- `docs/SHARED_BROWSER_OPERATOR_GUIDE.md` — primary operator/agent usage reference
- `docs/BUILD_READY_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/REVIEW_WORKFLOW.md`

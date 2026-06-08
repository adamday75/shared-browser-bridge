# Milestone 4 Build 1: OpenClaw Adapter

## What this is

`src/adapters/openclaw.js` is a thin local HTTP client for the shared-browser-bridge. It exposes a selected Build 1 subset of bridge API endpoints as named methods so OpenClaw code can drive the bridge without constructing raw fetch calls.

It is a caller, not a framework. There is no retry logic, no plugin packaging, no auth layer, and no abstraction for multiple clients.

## What it is not

- Not a plugin or packaged SDK
- Not a connection manager (does not start or restart Chrome)
- Not the bridge itself — the bridge must already be running
- Not safe for remote/public exposure — designed for 127.0.0.1 only
- Does not wrap every bridge endpoint — only the Build 1 surface listed below

## Requirements

### Runtime

Node.js 18 or later. The adapter uses `globalThis.fetch` and `AbortSignal.timeout()`, both available without flags in Node 18+. If you must run on an older Node version, pass a compatible `fetchImpl` via the options object.

### Windows Chrome (CDP)

The bridge connects to a real visible Chrome instance via CDP. On Windows, Chrome must be launched with the remote debugging port open:

```
chrome.exe --remote-debugging-port=9222
```

Or use the bridge's own launcher if configured.

### Bridge must already be running

The adapter makes HTTP calls to the bridge. It does not start the bridge. Start it first:

```sh
npm start
# or
node src/index.js
```

Default bridge URL: `http://127.0.0.1:7820`

## API

```js
import { createOpenClawAdapter } from './src/adapters/openclaw.js';

const adapter = createOpenClawAdapter({
  baseUrl: 'http://127.0.0.1:7820',  // default
  timeoutMs: 8000,                    // default
});
```

All methods return `{ status, body }`. Status mirrors the HTTP status code. Body is the parsed JSON from the bridge. On transport failure (network error, timeout), the method throws.

| Method | Bridge endpoint | Description |
|--------|----------------|-------------|
| `health()` | GET /health | Service health check |
| `tabs()` | GET /tabs | List open Chrome tabs |
| `goto({ url })` | POST /page/goto | Navigate to URL |
| `url()` | GET /page/url | Current page URL |
| `pause({ reason? })` | POST /control/pause | Pause agent control |
| `resume({ force?, adoptCurrentTarget? })` | POST /control/resume | Resume agent control |
| `state()` | GET /control/state | Full control state |
| `recover()` | POST /control/recover | Re-attach after ERROR or DETACHED |

`recover()` is included in Build 1 because the demo requires a clean start state regardless of how the bridge was left. Without it, the demo only works from ATTACHED, which is not reliably reproducible.

## Running the demo

```sh
node scripts/demo-openclaw-flow.mjs
```

The script requires the bridge to be running with Chrome attached. It does **not** launch Chrome or start the bridge.

### Execution environment note

For the current Windows-hosted bridge setup, the live demo was verified from **Windows PowerShell**, not WSL. The default adapter base URL is `http://127.0.0.1:7820`, which resolves correctly from Windows where the bridge listens, but not from WSL unless you explicitly route to the Windows host address.

### Required starting state

The demo handles three possible start states automatically:

- **ATTACHED** — proceeds directly
- **ERROR or DETACHED** — calls `recover()` first; if recovery fails (e.g. Chrome is not running), the demo prints the error and exits non-zero
- **PAUSED** — calls `resume({ force: true })` first to return to ATTACHED before proceeding

Any other state (e.g. a mid-transition state) is not handled and will likely cause a step to fail with a non-200 response.

### Expected successful output

```
[demo] health: OK
[demo] initial state: ATTACHED
[demo] goto: OK -> https://example.com
[demo] url: https://example.com/
[demo] pause: OK -> PAUSED
[demo] state while paused: PAUSED
[demo] resume: OK -> ATTACHED
[demo] final state: ATTACHED
```

When starting from PAUSED, a `resume (startup)` line appears before `goto`. When starting from ERROR or DETACHED, a `recover` line appears instead.

Exit code 0 on success, 1 if any required step fails.

## Live verification status

Live-verified on 2026-06-08 from **Windows PowerShell** with real Chrome/CDP and the real bridge:

- `ATTACHED` start state: passed end-to-end
- `PAUSED` start state: passed end-to-end, including `resume (startup)` normalization
- the demo now exits cleanly with exit code `0` after replacing forced `process.exit(...)` with `process.exitCode = ...`

`ERROR` / `DETACHED` start-state normalization remains implemented and test-covered, but was not live-exercised in the final M4 Build 2 run.

## Limitations

- `goto` only accepts `http:` and `https:` URLs (enforced by the bridge)
- `resume` without `force: true` checks for observable browser drift; if the tab changed since the last agent action, it returns 409 with drift details
- `recover` requires Chrome to be reachable on the configured CDP port; it will fail with 503 if Chrome is not running
- No retries or backoff — callers handle that if needed
- This is a thin local-first caller; it is not a full OpenClaw plugin integration

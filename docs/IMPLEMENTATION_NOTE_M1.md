# Implementation Note — Milestone 1: Chrome attach proof

## What was built

A minimal Node service (ESM, `node:http`, no frameworks) that:

- **`src/chrome/launcher.js`** — `findChromeExecutable()` checks common Windows
  install locations (`%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`,
  `%LOCALAPPDATA%`) plus Linux paths so the same code runs in WSL during
  development. `resolveChromeTarget()` first tries to **attach** to an
  already-running Chrome by GETting `/json/version` on the configured CDP host
  and port (default `127.0.0.1:9222`); only if that fails does it fall back to
  **launching** Chrome with `--remote-debugging-port=<port>` using the
  default profile (no throwaway `--user-data-dir`), then polls `/json/version`
  until it responds or a timeout elapses.
- **`src/cdp/session.js`** — `createCdpSession()` wraps the CDP HTTP surface:
  `getVersion()` and `listTabs()` (GET `/json/list`, filtered to `type ===
  'page'` and mapped to `{ id, title, url }`).
- **`src/state/store.js`** — tiny in-memory record of the last attach result
  (`attached`, `chrome`, `error`) read by the routes.
- **`src/api/server.js`** — boring `node:http` server with a fixed
  `"METHOD path"` route table, JSON responses, and one log line per request.
- **`src/api/routes/health.js`** — `GET /health`: reports `attached`, the
  attach `mode` (`attached`/`launched`), `browser` version string, `endpoint`,
  and `visible` (derived from whether the CDP `User-Agent` contains
  `Headless` — real signal, not guessed).
- **`src/api/routes/tabs.js`** — `GET /tabs`: returns `{ count, tabs }` from
  the live CDP tab list, or `503` if not attached.
- **`src/index.js`** — wires it together: resolves the Chrome target, builds
  the store/session/server, binds to `127.0.0.1:7820` by default
  (localhost-only, per the spec's security stance), and logs each step.

Config is via env vars: `BRIDGE_HOST`, `BRIDGE_PORT`, `CDP_HOST`, `CDP_PORT`.

## Verification run

Started a real headless Chrome with `--remote-debugging-port=9333` (a stand-in
for "Chrome already running with CDP open" — the same HTTP surface a visible
Windows Chrome exposes), then ran the bridge against it:

```
$ CDP_PORT=9333 BRIDGE_PORT=7820 node src/index.js
[chrome] attached to existing CDP endpoint at http://127.0.0.1:9333 (Chrome/149.0.7827.53)
[bridge] shared-browser-bridge listening on http://127.0.0.1:7820

$ curl http://127.0.0.1:7820/health
{"ok":true,"service":"shared-browser-bridge","attached":true,
 "chrome":{"mode":"attached","browser":"Chrome/149.0.7827.53",
 "endpoint":"http://127.0.0.1:9333","visible":false},"error":null}

$ curl http://127.0.0.1:7820/tabs
{"ok":true,"count":1,"tabs":[{"id":"3EE2...","title":"about:blank","url":"about:blank"}]}
```

`visible: false` is correct — the test instance was launched headless, and the
CDP `User-Agent` honestly reported `HeadlessChrome`.

Also exercised the failure paths:
- `GET /tabs` returns `503 {"ok":false,"error":"not attached to Chrome"}` when
  no Chrome is reachable.
- `GET /unknown-path` returns `404`.
- `/health` reports `attached: false` and a real `error` message when no CDP
  endpoint can be found or launched.

## Caveats / known limitations (honest, by design)

- **The launch fallback only helps on a cold start.** Chrome's single-instance
  behavior means launching `chrome.exe --remote-debugging-port=...` while
  another Chrome is already running on that profile just forwards the request
  to the existing process and exits — the new flag is silently ignored, so no
  CDP endpoint appears (we observed exactly this in testing: `attach` failed,
  `launch` spawned, then the version poll still timed out). The honest fix is
  **not** to fight this with a throwaway profile (that would be the fake
  managed-browser path the project explicitly rejects). Instead, the
  documented real-world setup is: start the user's real Chrome with
  `--remote-debugging-port` already enabled (e.g. via a shortcut), and let the
  bridge attach to it. The launch fallback remains useful for the case where
  no Chrome is running yet.
- `/tabs` does not report which tab is "active" — the CDP HTTP `/json/list`
  endpoint doesn't expose focus state, so we return the real tab list without
  inventing an active flag. Active-tab tracking belongs with the page-action
  work in Milestone 2/3 where a live CDP connection exists.
- No websocket/CDP session is opened yet — Milestone 1 only needs the HTTP
  `/json/*` surface for attach validation and tab discovery, which is real CDP,
  just not the full protocol.

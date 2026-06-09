# Build-Ready Spec — shared-browser-bridge

Status: Approved draft
Date: 2026-06-06
Owner: Adam + Gary

## 1. Product statement

Build a local shared-control browser bridge that lets agents use the user's real visible Chrome session instead of a fake automation browser.

The bridge should run on Windows, attach to Chrome through CDP, and expose a minimal local API that tools on WSL or the host can call.

## 2. Why this exists

Current options keep failing the actual need:
- headless browsers are invisible and detached from the user's real workflow
- managed automation Chromium instances are not the browser the human already lives in
- cookie import is brittle and misleading
- existing toolchains often claim "real Chrome" but actually launch a separate managed browser

The user need is simpler and more specific:
- use the real visible browser
- preserve real login state
- let the human interrupt
- let the agent resume

## 3. Primary user

Power users of OpenClaw / Claude / Codex / browser automation who are frustrated by fake browsers, cookie hacks, and hidden automation sessions.

## 4. V1 wedge

The smallest version worth building:
- Windows-hosted Node service
- attach to a real visible Chrome session via CDP
- local HTTP API on localhost
- commands:
  - health
  - tabs.list
  - tab.active
  - page.goto
  - page.click
  - page.type
  - page.snapshot
  - page.text
  - page.url
- minimal interrupt / resume state

## 5. Explicit non-goals for V1

Do not build these first:
- multi-user auth system
- cloud-hosted browser service
- polished GUI dashboard
- multi-browser parity
- full multi-agent orchestration layer
- deep site-specific recipes
- heavy browser extension UX

## 6. Browser-side decision

The controlled browser should live on **Windows**, not Linux/WSL.

Reason:
- the desktop-visible browser is on Windows
- the user logs in there
- session stability belongs there
- WSL is a caller/integration environment, not the browser home

This avoids the exact pain we observed with Xvfb-backed or separately managed browser lanes.

## 7. System boundary

### Runs on Windows
- Chrome launch / attach logic
- CDP connection manager
- local bridge API server
- local machine action guardrails
- optional human activity detector

### Runs on WSL or host clients
- OpenClaw adapter
- CLI clients
- other agent adapters
- test callers

## 8. V1 architecture

### Core modules
1. `src/chrome/launcher.js`
   - discover Chrome path
   - attach to existing Chrome or launch with CDP enabled
   - validate websocket endpoint

2. `src/cdp/session.js`
   - manage DevTools websocket connection
   - tab discovery / selection
   - command dispatch

3. `src/api/server.js`
   - local HTTP server
   - request validation
   - action routing

4. `src/api/routes/*.js`
   - health
   - tabs
   - page

5. `src/state/store.js`
   - current bridge state
   - stored baseline target id
   - pause/resume state
   - last human activity timestamp

6. `src/guards/handoff.js`
   - human active vs agent active
   - pause semantics
   - cooldown or safe resume policy

7. `src/adapters/openclaw.js`
   - first client adapter target

## 9. API draft

### `GET /health`
Returns service status, Chrome status, attached tab count, and mode.

Example response:
```json
{
  "ok": true,
  "service": "shared-browser-bridge",
  "attached": true,
  "chrome": {
    "mode": "cdp",
    "browser": "Chrome",
    "visible": true
  }
}
```

### `GET /tabs`
Returns open tabs and the stored baseline target id.

### `POST /page/goto`
Body:
```json
{ "url": "https://www.linkedin.com/feed/" }
```

### `POST /page/click`
Body:
```json
{ "selector": "button[aria-label='Like']" }
```

### `POST /page/type`
Body:
```json
{ "selector": "textarea", "text": "hello world" }
```

### `GET /page/url`
Returns current URL.

### `GET /page/text`
Returns readable text snapshot.

### `GET /page/snapshot`
Returns structured DOM summary / refs for agent use.

### `POST /control/pause`
Pauses agent control.

### `POST /control/resume`
Resumes agent control.

## 10. Handoff behavior

V1 should support a simple model:
- human can always take over physically in Chrome
- bridge can be paused explicitly by API
- bridge can resume explicitly by API
- later version may detect recent human input automatically

V1 rule: keep this simple and observable.

## 11. Security stance

V1 security should be local-first and boring:
- bind API to localhost by default
- optional shared secret token in env
- no remote internet exposure by default
- explicit allowlist of supported commands
- no arbitrary JavaScript execution in V1
- no arbitrary file system access from browser commands

## 12. Demo definition of done

The project is real when this demo works reliably:
1. Start shared-browser-bridge on Windows.
2. It attaches to visible Chrome with real logged-in session.
3. Agent client from WSL calls bridge.
4. Bridge navigates, clicks, types, and snapshots in that same visible browser.
5. Human interrupts manually.
6. Agent resumes from the current visible state.

## 13. Build session milestones

### Milestone 0 — repo + spec
- create repo
- write spec
- define module map
- define review workflow

### Milestone 1 — Chrome attach proof
- discover Chrome path on Windows
- launch/attach with CDP
- return `/health`
- return `/tabs`

### Milestone 2 — page actions
- implement goto
- implement click
- implement type
- implement url/text/snapshot

### Milestone 3 — handoff controls
- pause
- resume
- last activity state

### Milestone 4 — OpenClaw adapter
- simple caller script or tool adapter
- first real demo flow

## 14. Acceptance criteria

V1 is successful when:
- browser is visibly the real Windows Chrome session
- no separate fake browser is required for normal use
- LinkedIn or another logged-in site remains authenticated naturally
- agent commands work from WSL through the bridge
- human can interrupt without corrupting the session
- codebase is understandable enough for open-source contributors

## 15. Open questions for the build session

1. Attach to existing Chrome, or always launch a dedicated Chrome profile first?
2. Best selector strategy for click/type in V1?
3. Snapshot format: text-first or DOM-ref-first?
4. How much human-activity detection belongs in V1?
5. Should OpenClaw integration be a thin HTTP caller first, before any richer tool plugin?

## 16. Recommendation

Start with the smallest honest version:
- Windows Node service
- localhost API
- real Chrome attach
- simple pause/resume
- OpenClaw as first client

Do not build a fancy shell before the bridge itself is proven.

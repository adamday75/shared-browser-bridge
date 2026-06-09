# Shared Browser Bridge — Operator and Agent Guide

This is the primary usage reference for agents and human operators working with the shared-browser-bridge. Read this before driving the bridge.

---

## 1. What this bridge is

The shared-browser-bridge is a local HTTP service that attaches to a real, visible Chrome session running on your Windows desktop. It lets agents (scripts, AI operators, automation) drive the same browser the human is already using — with real login state, real cookies, and real session history.

It is **not** a fake automation browser, a cloud browser, or a headless browser. It is **not** a remotely deployed service. It binds to localhost by default and is intended for single-user local operation.

Because it controls a real visible browser, actions taken through the bridge are visible to the human user and operate inside their real signed-in accounts.

---

## 2. Core operating model

The bridge attaches to Chrome via Chrome DevTools Protocol (CDP). Once attached, it exposes a small HTTP API on `http://127.0.0.1:7820`.

The bridge tracks one **observable browser target** at a time — a specific open tab identified by its CDP target id. When the bridge records a baseline, it stores that target id and URL. Subsequent resume checks compare the current first-listed page target against the stored baseline.

**What the bridge does not do:**

The CDP HTTP endpoint (`/json/list`) does not expose which tab the human has currently focused or brought to the foreground. The bridge has no way to know which tab the human is looking at. It cannot follow focus changes or detect tab switches where the baseline tab is still open and at the same URL.

The `pause` and `resume` controls are ownership and state management tools. They are not magic active-tab tracking. Pause means the agent is handing control to the human. Resume means the agent is taking control back and verifying browser state before proceeding.

---

## 3. Current target semantics

### Definitions

- **`targetTab`** — the stored baseline: the tab id, URL, and title the bridge recorded the last time a target was adopted. Set on attach, recover, or any explicit adopt operation. Cleared when the bridge enters DETACHED or when no page tabs exist.

- **Observable browser target** — the first page target returned by CDP's `/json/list` at the time of a check. This is what the bridge actually compares against the baseline. The ordering is browser-internal and not guaranteed to match human focus or activation order.

- **Human-focused tab** — the tab the human is actively looking at. The bridge **cannot observe this** with the current HTTP-only CDP model. Do not assume the bridge knows which tab the human has focused.

### Drift detection

Drift fires when the first-listed page target has a different id or URL than the stored baseline. Drift does **not** fire when:
- The human switches to a different focused tab while the baseline tab is still open at the same URL
- The URL changes in a tab other than the one at the top of CDP's internal listing

This is an honest limitation, not a bug. The drift check protects against the most common observable changes, but it is narrower than true focused-tab tracking.

### Switching tabs deliberately

Use `GET /tabs` to list all open page targets, then pass the chosen id as `adoptTargetId` on `POST /control/resume`. This is the reliable way to tell the bridge which tab to work on. Do not guess from tab ordering.

---

## 4. Runtime and environment setup

### Intended production setup: bridge on Windows

The intended setup is Chrome running on Windows and the bridge also running on Windows, side by side:

```
Windows Chrome (--remote-debugging-port=9222)
     ↓
Windows Node bridge (node src/index.js)
     ↓
Agent calls over 127.0.0.1:7820
```

From WSL, the bridge is reachable at `http://127.0.0.1:7820` without extra configuration — WSL2 forwards the loopback to Windows automatically.

### WSL-side bridge against Windows Chrome (development mode)

If you run the bridge from WSL against a Windows Chrome, you may find that `127.0.0.1:9222` is unreachable from WSL even though Chrome is listening. This is a known WSL2 networking behavior: WSL cannot always reach Windows services on the Windows loopback address.

Use the Windows host IP instead. Find it from WSL:

```bash
cat /etc/resolv.conf | grep nameserver | awk '{print $2}'
# example output: 172.22.96.1
```

Start the bridge with that host:

```bash
# Windows Chrome already running with --remote-debugging-port=9222
CDP_HOST=172.22.96.1 node src/index.js
```

Verified in live testing: `127.0.0.1:9222` returned connection refused from WSL; `172.22.96.1:9222` succeeded.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_HOST` | `127.0.0.1` | Host the bridge HTTP server binds to |
| `BRIDGE_PORT` | `7820` | Port the bridge HTTP server listens on |
| `BRIDGE_API_TOKEN` | (unset) | Optional bearer token for all routes |
| `CDP_HOST` | `127.0.0.1` | Chrome DevTools Protocol host |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `CDP_ALLOW_REMOTE_LAUNCH` | (unset) | Set to `1` to allow Chrome launch fallback for non-local CDP hosts. Off by default because launching a local browser when CDP_HOST points elsewhere would silently control the wrong browser. |
| `TAKEOVER_POLL_INTERVAL_MS` | `2000` | How often the passive takeover poller checks for drift while ATTACHED |

---

## 5. Control states

The bridge is always in one of these states, visible at `GET /control/state`.

| State | Meaning | What to do next |
|---|---|---|
| `ATTACHED` | Bridge is connected to Chrome and ready for agent actions | Issue page commands; or `POST /control/pause` to hand off to the human |
| `PAUSED` | Agent has yielded control; human may be acting | Human completes their action, then call `POST /control/resume` |
| `DETACHED` | Bridge has no Chrome connection | Call `POST /control/recover` to reconnect, or restart Chrome and recover |
| `ERROR` | An error occurred (CDP lost, no open tabs, etc.) | Call `POST /control/recover` to attempt reconnection; call `POST /control/detach` to reset cleanly if recover fails |
| `AGENT_ACTIVE` | A page action is in progress | Wait for the current action to complete |
| `HUMAN_ACTIVE` | Human activity was detected | Wait, then issue `POST /control/pause` or let the takeover poller handle it |

### From ERROR

From `ERROR`, you have two paths:

1. `POST /control/recover` — attempts to reconnect to Chrome and get a fresh baseline. Returns `ATTACHED` on success.
2. `POST /control/detach` — resets to `DETACHED` cleanly without attempting to reconnect. Use when Chrome is not running or you want a fresh start.

---

## 6. Core workflow recipes

### Normal attach and use

```
GET /control/state           → expect ATTACHED (bridge started successfully)
POST /page/goto { url }      → navigate
GET /page/text               → read page content
POST /page/click { selector }
```

### Human interrupt — pause and resume

```
POST /control/pause          → yields to human (bridge stays PAUSED)
... human does their work ...
POST /control/resume {}      → verify state and resume
```

If resume returns `TARGET_DRIFT`, the first page target changed while paused. See Section 7.

### Explicit target selection (multi-tab workflow)

```
GET /tabs                    → lists all open tabs + baselineTargetId
POST /control/pause          → optional but recommended before switching targets
POST /control/resume { "adoptTargetId": "<id>" }   → adopt the specific tab
POST /page/goto { url }      → now driving the adopted tab
```

This is the reliable multi-tab workflow. Do not navigate or act on a tab you haven't explicitly adopted.

**Runnable proof script:** `scripts/demo-explicit-target-flow.mjs` walks this sequence (health → enumerate tabs → select deterministically → adopt with `adoptTargetId` → verify `adoptedTarget.id` in response → post-adoption safe read) and prints a PASS/FAIL summary. PASS confirms deterministic selection and that the adopt response body confirms the correct tab id. It does not prove that the subsequent `GET /page/url` read operated on the adopted tab — in a multi-tab setup that read returns the first CDP-listed target, which may differ. Run it to confirm explicit target selection works in a live setup:

```sh
node scripts/demo-explicit-target-flow.mjs --match-url "example.com"
```

### Blocked resume — TARGET_DRIFT

```
POST /control/resume {}
→ 409 TARGET_DRIFT
  response includes:
    drift: { expectedTabId, expectedUrl, currentTabId, currentUrl, ... }
    availableTargets: [ { id, url, title }, ... ]
```

Your options from here:
- `POST /control/resume { "adoptCurrentTarget": true }` — accept whatever tab is first in CDP's listing now
- `POST /control/resume { "adoptTargetId": "<id>" }` — pick a specific tab from `availableTargets`
- `POST /control/resume { "force": true }` — resume without updating the baseline (use rarely; see Section 7)

### Recovery from broken state

```
GET /control/state           → see ERROR state
POST /control/recover        → reconnect attempt
```

If recover fails with `NO_PAGE_TARGET`: open a page in Chrome, then call recover again.

If recover fails with `CDP_ERROR`: Chrome is not running or not reachable. Start Chrome with `--remote-debugging-port=9222` and try again.

If the ERROR state cannot be cleared: `POST /control/detach` resets to `DETACHED`.

---

## 7. Resume options explained

All resume options are passed as a JSON body to `POST /control/resume`.

### `resume({})` — default resume with baseline check

Checks whether the observable browser target has changed since the last agent baseline.

- If no agent has acted and no baseline exists: resumes cleanly (nothing to verify).
- If an agent acted but no baseline was recorded: returns `MISSING_BASELINE`. Pass `adoptCurrentTarget`, `adoptTargetId`, or `force` to proceed.
- If a baseline exists and the first-listed tab matches it: resumes cleanly.
- If the first-listed tab differs: returns `TARGET_DRIFT`.

Use this as the default safe resume path.

### `resume({ adoptCurrentTarget: true })` — accept current first target

Accepts whatever `getFirstPageTarget()` returns (the first page target in CDP's `/json/list` ordering) and records it as the new baseline. Transitions to `ATTACHED` regardless of whether the first tab matches the prior baseline.

**Important:** this does NOT adopt the tab the human is currently focused on. It adopts the first tab in CDP's internal listing, which may or may not be the one the human was using. Use `adoptTargetId` when you need to pick a specific tab precisely.

Use this when: you know the human changed pages and you want to accept whatever they left the browser on, without caring which specific tab it is.

### `resume({ adoptTargetId: "<id>" })` — explicit target by id

Enumerates all open page targets with `GET /tabs`, finds the one with the given id, and adopts it as the new baseline. Returns `TARGET_NOT_FOUND` (with `availableTargets`) if the id is not among the currently open tabs.

Cannot be combined with `adoptCurrentTarget` or `force`.

Use this when: you need to drive a specific known tab (LinkedIn, X, a specific app). Get the id from `GET /tabs` first.

### `resume({ force: true })` — bypass all checks

Resumes without any verification or baseline update. The stored baseline is not changed. The bridge transitions directly to `ATTACHED`.

Use this when: you know exactly what you are doing and the current state is intentionally mismatched. Do not use force casually — it skips all safety checks.

Cannot be combined with `adoptTargetId`.

---

## 8. Error handling guide

All error responses include `{ ok: false, code: "...", error: "..." }`. Parse `code` for programmatic handling — the `error` string is human-readable and may change between versions.

| Code | HTTP | Meaning | What to do |
|---|---|---|---|
| `TARGET_DRIFT` | 409 | The first page target changed since the last agent baseline | Inspect `drift` and `availableTargets` in the response. Use `adoptCurrentTarget`, `adoptTargetId`, or `force` |
| `TARGET_NOT_FOUND` | 409 | `adoptTargetId` was passed but no open tab has that id | Check `availableTargets` in the response for valid ids |
| `MISSING_BASELINE` | 409 | Agent previously acted but no observable baseline was recorded | Use `adoptCurrentTarget` to accept the current first tab, `adoptTargetId` to pick a specific one, or `force` to skip |
| `NO_PAGE_TARGET` | 409 | No open browser page tabs found | Open a page in Chrome. If bridge is in ERROR, call `POST /control/recover` |
| `CDP_ERROR` | 503 | Chrome connection failed or lost | Verify Chrome is running with `--remote-debugging-port`. Call `POST /control/recover` |
| `STATE_CONFLICT` | 409 | State transition rejected; operation not allowed in current state | Call `GET /control/state` to see the current state and decide what is valid next |
| `INVALID_INPUT` | 400 | Request body missing a required field or has bad content | Fix the request body per the error message |
| `NOT_ATTACHED` | 503 | Bridge is not attached to Chrome | Call `POST /control/recover` or restart the bridge |
| `AUTH_FAILED` | 401 | Token required but missing or wrong | Include `Authorization: Bearer <token>` header |
| `PAUSED` | 409 | Bridge is paused; page actions rejected | Call `POST /control/resume` first |
| `PAGE_ACTION_ERROR` | 404/502/504 | Element not found, navigation error, or timeout | Check the target page state; the selector may not exist or the navigation may have failed |

---

## 9. Multi-tab usage examples

These examples use realistic tab scenarios — LinkedIn, X, an AI Optimizer app, Instagram.

### Switching between signed-in tabs

You have three tabs open: LinkedIn, X, Instagram. You want to read content from X.

```bash
# Step 1: see what is open
GET /tabs
# response:
# {
#   "ok": true, "count": 3, "baselineTargetId": "A1B2",
#   "tabs": [
#     { "id": "A1B2", "url": "https://www.linkedin.com/feed/", "title": "LinkedIn" },
#     { "id": "C3D4", "url": "https://x.com/home", "title": "X" },
#     { "id": "E5F6", "url": "https://www.instagram.com/", "title": "Instagram" }
#   ]
# }

# Step 2: pause (optional but clean)
POST /control/pause

# Step 3: adopt the X tab explicitly
POST /control/resume { "adoptTargetId": "C3D4" }
# response: { "ok": true, "controlState": "ATTACHED", "adoptedTarget": { "id": "C3D4", ... } }

# Step 4: act on X
GET /page/text     → reads the X feed
```

### Resume after human interrupt with drift

Human paused the bridge, switched to LinkedIn, then came back.

```bash
POST /control/resume {}
# 409 TARGET_DRIFT
# {
#   "drift": {
#     "expectedTabId": "C3D4", "expectedUrl": "https://x.com/home",
#     "currentTabId": "A1B2", "currentUrl": "https://www.linkedin.com/feed/",
#   },
#   "availableTargets": [
#     { "id": "A1B2", "url": "https://www.linkedin.com/feed/", "title": "LinkedIn" },
#     { "id": "C3D4", "url": "https://x.com/home", "title": "X" },
#   ]
# }

# Option A: continue on LinkedIn (where human left off)
POST /control/resume { "adoptTargetId": "A1B2" }

# Option B: go back to X
POST /control/resume { "adoptTargetId": "C3D4" }
```

### AI Optimizer tab switching

You need to pull data from an AI Optimizer dashboard, then post to LinkedIn.

```bash
GET /tabs
# pick the AI Optimizer tab id, e.g. "F7G8"
POST /control/resume { "adoptTargetId": "F7G8" }
GET /page/text    → scrape the AI Optimizer data

POST /control/pause   → clean handoff before switching targets
GET /tabs             → confirm ids still valid
POST /control/resume { "adoptTargetId": "A1B2" }   → LinkedIn
POST /page/click { "selector": "button[data-id='create-post']" }
```

---

## 10. Known limitations

### No true focused-tab detection

The bridge cannot observe which tab the human is looking at. CDP's HTTP `/json/list` surface returns all open page targets but provides no "is focused" or "is active" signal. The bridge's drift check compares against the first-listed target, which is not the same as the foreground/focused tab.

Consequence: switching the human-focused tab does not automatically update the bridge's baseline or trigger drift detection, unless the first-listed target in CDP's ordering also changed.

If you need focused-tab-aware behavior, the current HTTP-only CDP model cannot provide it. A stronger solution would require a Chrome extension or a WebSocket-level integration that can observe `Target.activatedTarget` events — a larger architectural change not part of the current bridge.

### Tab ordering is not focus ordering

`GET /tabs` returns tabs in CDP's internal ordering, which is not guaranteed to match the order the human opened them or the order they appear in the Chrome tab bar. Do not infer human intent from tab position.

### WSL CDP connectivity

When running the bridge from WSL against a Windows Chrome, `127.0.0.1` may not reach the Windows host CDP endpoint. Use the Windows host IP from `/etc/resolv.conf`. See Section 4.

### Baseline after adopt

After `adoptTargetId` or `adoptCurrentTarget`, the new baseline is the tab at the time of the call. If the human immediately navigates that tab, the baseline URL becomes stale but the bridge will not know until the next drift check.

---

## 11. Safe-agent rules

Follow these rules to avoid unsafe or incorrect browser behavior.

1. **Do not assume the bridge's target is the human's focused tab.** The bridge tracks a stored baseline, not live focus. If you need to work on a specific tab, adopt it explicitly.

2. **Prefer `adoptTargetId` when multiple tabs matter.** `adoptCurrentTarget` accepts whatever CDP lists first — this may not be the tab you intended. `adoptTargetId` is explicit and safe.

3. **Do not use `force` casually.** Force bypasses all state verification. Use it only when you have an explicit reason to skip checks and you understand what state the bridge is in.

4. **Inspect state before risky actions.** Call `GET /control/state` before navigating or interacting in any context where the target tab may have changed. A quick state check is cheap; an action on the wrong tab is not.

5. **Pause before switching tabs.** When you need to move from one tab to another, pause first, then adopt the new target, then resume. This creates a clean handoff point and avoids acting on stale state.

6. **Pause and ask instead of guessing.** If you are unsure which tab the human left the browser on, pause and ask the human to confirm before proceeding. Do not guess from tab ordering.

7. **Check `availableTargets` on any drift or not-found error.** The bridge includes the full open-tab list in these error responses. Use it instead of calling `GET /tabs` again unnecessarily.

---

## 12. Command reference

Quick examples for all primary operations.

### Inspect state

```bash
curl http://127.0.0.1:7820/control/state
```

Response includes `controlState`, `targetTab`, `lastAgentAction`, `lastHumanActivity`, `pauseReason`, `error`, and `chrome` endpoint info.

### List open tabs

```bash
curl http://127.0.0.1:7820/tabs
```

Response includes `count`, `baselineTargetId` (the id of the bridge's stored baseline tab, or null), and `tabs` (array of `{ id, url, title }`).

### Pause

```bash
curl -X POST http://127.0.0.1:7820/control/pause \
  -H "Content-Type: application/json" \
  -d '{}'

# with optional reason:
curl -X POST http://127.0.0.1:7820/control/pause \
  -H "Content-Type: application/json" \
  -d '{ "reason": "human reviewing LinkedIn post" }'
```

### Resume (default — verify baseline)

```bash
curl -X POST http://127.0.0.1:7820/control/resume \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Resume (adopt current first target)

Accepts whatever the first page target in CDP's listing is. Does NOT adopt the focused/foreground tab — adopts the first one in CDP's internal order.

```bash
curl -X POST http://127.0.0.1:7820/control/resume \
  -H "Content-Type: application/json" \
  -d '{ "adoptCurrentTarget": true }'
```

### Resume (adopt specific tab by id)

Get the id from `GET /tabs` first.

```bash
curl -X POST http://127.0.0.1:7820/control/resume \
  -H "Content-Type: application/json" \
  -d '{ "adoptTargetId": "C3D4" }'
```

### Recover from ERROR or DETACHED

```bash
curl -X POST http://127.0.0.1:7820/control/recover \
  -H "Content-Type: application/json" \
  -d '{}'
```

### Health check

```bash
curl http://127.0.0.1:7820/health
```

### Page actions

```bash
# Navigate
curl -X POST http://127.0.0.1:7820/page/goto \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://www.linkedin.com/feed/" }'

# Click
curl -X POST http://127.0.0.1:7820/page/click \
  -H "Content-Type: application/json" \
  -d '{ "selector": "button.share-box-feed-entry__trigger" }'

# Read URL
curl http://127.0.0.1:7820/page/url

# Read page text
curl http://127.0.0.1:7820/page/text

# DOM snapshot
curl http://127.0.0.1:7820/page/snapshot
```

### With authentication token

If `BRIDGE_API_TOKEN` is set, include it on every request:

```bash
curl -H "Authorization: Bearer <your-token>" http://127.0.0.1:7820/control/state
```

# OpenClaw Agent — Bridge Integration Quickstart

This is the agent-facing integration guide. It answers: *I am an OpenClaw agent. The bridge is running. What do I do?*

For the full operator reference, environment setup, and deep explanations, see `docs/SHARED_BROWSER_OPERATOR_GUIDE.md`.

---

## 1. Import and configure

```js
import { createOpenClawAdapter } from './src/adapters/openclaw.js';

const bridge = createOpenClawAdapter({
  baseUrl: 'http://127.0.0.1:7820',  // default; WSL agents reach a Windows bridge automatically
  // timeoutMs: 8000,                 // optional, default is 8 seconds
});
```

If the bridge uses `BRIDGE_API_TOKEN`, inject the header via a custom `fetchImpl`:

```js
const bridge = createOpenClawAdapter({
  fetchImpl: (url, init = {}) => {
    const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${token}` };
    return globalThis.fetch(url, { ...init, headers });
  },
});
```

---

## 2. Method reference

| Method | HTTP | Returns |
|---|---|---|
| `health()` | `GET /health` | `{ ok, status }` |
| `state()` | `GET /control/state` | `{ controlState, targetTab, ... }` |
| `tabs()` | `GET /tabs` | `{ count, baselineTargetId, tabs: [{ id, url, title }] }` |
| `pause({ reason? })` | `POST /control/pause` | `{ controlState: 'PAUSED' }` |
| `resume({ adoptTargetId?, adoptCurrentTarget?, force? })` | `POST /control/resume` | `{ controlState: 'ATTACHED', adoptedTarget? }` |
| `recover()` | `POST /control/recover` | `{ controlState, chrome, targetTab }` |
| `goto({ url })` | `POST /page/goto` | `{ url }` |
| `url()` | `GET /page/url` | `{ url }` |
| `text()` | `GET /page/text` | `{ text }` |
| `snapshot()` | `GET /page/snapshot` | `{ snapshot }` |
| `click({ selector })` | `POST /page/click` | `{ selector }` |
| `type({ selector, text })` | `POST /page/type` | `{ selector }` |

All methods return `{ status, body }`. On error, `body` is `{ ok: false, code, error }`. Parse `code` for programmatic handling — the `error` string is human-readable and may change.

---

## 3. Recommended sequence for explicit tab work

This is the reliable path for an agent that needs to drive a specific tab (LinkedIn, X, an app dashboard, etc.).

```js
// 1. Confirm the bridge is reachable
const h = await bridge.health();
if (!h.body?.ok) throw new Error('bridge unreachable');

// 2. Check current state
let { body: s } = await bridge.state();
let controlState = s.controlState;

// 3. Recover if disconnected
if (controlState === 'ERROR' || controlState === 'DETACHED') {
  const r = await bridge.recover();
  if (!r.body?.ok) throw new Error(`recover failed: ${r.body?.code}`);
  controlState = r.body.controlState;
}

// 4. List open tabs and select by URL or id
const t = await bridge.tabs();
const target = t.body.tabs.find(tab => tab.url.includes('linkedin.com'));
if (!target) throw new Error('LinkedIn tab not found');

// 5. Pause before switching targets
await bridge.pause({ reason: 'explicit target adoption' });

// 6. Adopt the chosen tab explicitly
const r = await bridge.resume({ adoptTargetId: target.id });
if (!r.body?.ok || r.body.adoptedTarget?.id !== target.id) {
  throw new Error(`adoption failed: ${r.body?.code}`);
}

// 7. Act on the page
// Important: text/snapshot/click/type operate on the first CDP-listed target,
// not the explicitly adopted tab. In a single-tab session these are the same.
// In multi-tab setups, post-adoption page reads are not guaranteed to reflect
// the adopted tab — see docs/SHARED_BROWSER_OPERATOR_GUIDE.md.
const { body: content } = await bridge.text();
// ... read, click, type, goto as needed ...

// 8. Yield control back when done
await bridge.pause({ reason: 'agent work complete' });
```

For the runnable workflow (adoption + structured page brief), see `scripts/demo-openclaw-page-brief.mjs` (M11 canonical path).

`scripts/demo-explicit-target-flow.mjs` is the earlier M8 proof script — adoption only, no brief, kept as historical reference.

---

## 4. Handling common blocking codes

These are the codes that require an agent decision. Check `body.code`, not `body.error`.

### `TARGET_DRIFT` (409)

The first-listed browser tab changed since the last agent baseline.

```js
const r = await bridge.resume({});
if (r.body?.code === 'TARGET_DRIFT') {
  const { drift, availableTargets } = r.body;
  // drift.expectedTabId / expectedUrl — what was stored
  // drift.currentTabId / currentUrl  — what CDP sees now
  // availableTargets                 — full open-tab list

  // Option A: accept what is there now (no specific tab required)
  await bridge.resume({ adoptCurrentTarget: true });

  // Option B: pick a specific tab (preferred when you know which one)
  const chosen = availableTargets.find(t => t.url.includes('x.com'));
  await bridge.resume({ adoptTargetId: chosen.id });
}
```

**Important:** `adoptCurrentTarget` adopts the first tab in CDP's internal ordering — not the tab the human is focused on. The bridge cannot observe human focus. Use `adoptTargetId` when you need a specific tab.

### `MISSING_BASELINE` (409)

Agent previously acted but no observable baseline was recorded. Same resolution as `TARGET_DRIFT`: use `adoptCurrentTarget`, `adoptTargetId`, or (rarely) `force`.

### `TARGET_NOT_FOUND` (409)

`adoptTargetId` was passed but no open tab has that id (tab was closed).

```js
// Response includes availableTargets — use it directly without a GET /tabs round-trip
const { availableTargets } = r.body;
```

### `NO_PAGE_TARGET` (409)

No open browser page tabs. Open a page in Chrome, then call `bridge.recover()`.

---

## 5. Ambiguity and drift recovery rules

1. **Do not assume the bridge's target is the human's focused tab.** Adopt explicitly when it matters.
2. **Prefer `adoptTargetId` over `adoptCurrentTarget` when you know which tab to use.** `adoptCurrentTarget` accepts whatever CDP lists first.
3. **Pause before switching tabs.** Clean handoff before every target change.
4. **Use `availableTargets` from error responses.** It is already a fresh tab list — no extra `GET /tabs` needed.
5. **Do not use `force` casually.** It skips all verification. Use only when you have an explicit reason.
6. **If ambiguous, pause and ask.** Do not guess from tab ordering.

---

## 6. Further reading

- `docs/SHARED_BROWSER_OPERATOR_GUIDE.md` — full operator reference: environment setup, state machine, all resume options, multi-tab examples, safe-agent rules, command reference
- `scripts/demo-openclaw-page-brief.mjs` — M11 canonical runnable workflow: explicit target selection → adoption → structured page brief (JSON)
- `scripts/demo-explicit-target-flow.mjs` — M8 historical proof script: adoption only, no brief; kept as supporting context
- `README.md` — quickstart, error codes, WSL setup, drift/recovery introspection reference

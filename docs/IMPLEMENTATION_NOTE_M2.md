# Implementation Note — Milestone 2: page actions

## What was built

Page actions over the **live CDP protocol** (not just the `/json/*` HTTP
surface M1 used). New code:

- **`src/cdp/page.js`** — opens a short-lived websocket connection (Node 22's
  built-in `WebSocket`, no new dependency) to a single page target's
  `webSocketDebuggerUrl`, sends CDP commands, and closes when the action is
  done. Each request gets its own connection — boring and stateless, nothing
  to keep alive or reconnect across navigations/tab changes. Implements:
  - `gotoUrl` — `Page.enable` + `Page.navigate`, awaits `Page.loadEventFired`
  - `clickSelector` — `DOM.querySelector` to find the node, `DOM.getBoxModel`
    to find its center point, then real `Input.dispatchMouseEvent`
    move/press/release — a genuine synthesized mouse click, not `el.click()`
  - `typeIntoSelector` — `DOM.querySelector` + `DOM.focus` +
    `Input.insertText` — a genuine synthesized input event, not `el.value = `
  - `getPageText` / `getPageSnapshot` — `Runtime.evaluate` with two **fixed,
    read-only, non-interpolated** expressions (`document.body.innerText`, and
    a bounded query over interactive/heading elements returning
    `{ tag, text, id }`). See "On `Runtime.evaluate`" below for why this is
    not the "arbitrary JavaScript execution" the spec's security stance rules
    out.
- **`src/api/body.js`** — tiny `readJsonBody(req)` helper (the first POST
  routes in this codebase; M1 had none). Caps the body at 1 MB — generously
  larger than any legitimate page-action payload (a URL, a selector, a string
  to type) — and destroys the connection mid-stream once exceeded, rejecting
  with `BodyTooLargeError` (`status: 413`). Route handlers map this to a clean
  `413 {"ok":false,"error":"request body exceeds the 1048576-byte limit"}`
  instead of buffering an unbounded body into memory.
- **`src/api/routes/page.js`** — six route handlers (`gotoRoute`,
  `clickRoute`, `typeRoute`, `urlRoute`, `textRoute`, `snapshotRoute`) that
  validate input, check attach state, and translate `PageActionError` (with
  its own HTTP status) into JSON responses. Unknown errors still bubble to
  the server's existing 500 handler.
- **`src/cdp/session.js`** — added `getFirstPageTarget()` (and a shared
  `listPageTargets()` used by both it and the existing `listTabs()`), which
  returns the raw CDP target — including `webSocketDebuggerUrl` — for the
  first open page tab.
- **`src/api/server.js`** — registered the six new routes in the route table.

## On "active tab"

CDP's HTTP `/json/list` has no concept of a focused tab (this was already
called out as a known gap in the M1 note). Page actions therefore operate on
**the first open page target**, returned by `getFirstPageTarget()`. This is
an honest stand-in, not a guess at "active" — true active-tab tracking needs
either a live `Target` domain subscription or human-activity signals, and
belongs with the Milestone 3 handoff/state work.

## On `Runtime.evaluate`

The spec's security stance says "no arbitrary JavaScript execution in V1."
That rule is about not exposing an `eval`-like endpoint where a *caller*
supplies code — it sits next to "explicit allowlist of supported commands."
`getPageText` and `getPageSnapshot` use `Runtime.evaluate` internally with
two fixed, hardcoded, read-only expressions that take no caller input; the
caller cannot influence what code runs. This is the same technique
Puppeteer/Playwright use internally for `innerText()` / accessibility
summaries — CDP has no `DOM`-only command for "rendered visible text" or "a
structured interactive-element summary." `click` and `type`, by contrast,
deliberately avoid `Runtime.evaluate` (no `el.click()` / `el.value =`) and
use the `DOM` + `Input` domains to synthesize real mouse and keyboard events,
which is the more honest CDP-native path for those two actions.

## Verification run

Started a real headless Chrome on `127.0.0.1:9333` (same stand-in approach as
M1 — the same HTTP+CDP surface a visible Windows Chrome exposes), ran the
bridge against it, and exercised every M2 route:

```
$ CDP_PORT=9333 BRIDGE_PORT=7821 node src/index.js
[chrome] attached to existing CDP endpoint at http://127.0.0.1:9333 (Chrome/149.0.7827.53)
[bridge] shared-browser-bridge listening on http://127.0.0.1:7821

$ curl -X POST :7821/page/goto -d '{"url":"https://example.com/"}'
{"ok":true,"url":"https://example.com/"}

$ curl :7821/page/url
{"ok":true,"url":"https://example.com/"}

$ curl :7821/page/text
{"ok":true,"text":"Example Domain\n\nThis domain is for use in documentation
 examples without needing permission. Avoid use in operations.\n\nLearn more"}

$ curl :7821/page/snapshot
{"ok":true,"snapshot":[{"tag":"h1","text":"Example Domain","id":null},
                        {"tag":"a","text":"Learn more","id":null}]}

$ curl -X POST :7821/page/goto -d '{"url":"https://www.google.com/"}'
$ curl -X POST :7821/page/type -d '{"selector":"textarea[name=q]","text":"shared browser bridge"}'
{"ok":true,"selector":"textarea[name=q]"}
# snapshot afterwards confirms the textarea now holds "shared browser bridge"
# typed via real Input.insertText, not a value assignment

$ curl -X POST :7821/page/goto -d '{"url":"https://example.com/"}'
$ curl -X POST :7821/page/click -d '{"selector":"a"}'
{"ok":true,"selector":"a"}
$ curl :7821/page/url
{"ok":true,"url":"https://www.iana.org/help/example-domains"}
# real Input.dispatchMouseEvent click followed the link and navigated —
# proof this is a synthesized mouse event, not a scripted .click()
```

Also exercised failure paths:
- `POST /page/click` with a selector matching nothing → `404
  {"ok":false,"error":"no element matched selector \"#does-not-exist\""}`
- `POST /page/goto` with no `url` in the body → `400
  {"ok":false,"error":"body must include a non-empty \"url\" string"}`
- A body over the 1 MB cap → `413
  {"ok":false,"error":"request body exceeds the 1048576-byte limit"}`,
  verified directly against `readJsonBody` with a >1 MB payload (a small
  body still parses normally; an oversized one rejects as
  `BodyTooLargeError` with `status: 413` before being fully buffered)
- `GET /health` and `GET /tabs` (Milestone 1 routes) still return `200` —
  no regression from the new route table entries.

## Milestone 2 hardening (post-review pass)

Five items closed after the M2 review (three initial, two in a follow-up patch):

1. **URL scheme allowlist** — `POST /page/goto` now uses `new URL()` to parse the
   submitted URL and checks `parsed.protocol` against an explicit allowlist:
   `{ 'http:', 'https:' }`. Any URL that fails to parse or whose scheme is not in
   the allowlist is rejected with `400 {"ok":false,"error":"URL scheme not allowed:
   only http and https are permitted"}` before the URL ever reaches CDP. This
   replaces the previous denylist (`javascript:`, `data:`, `file:`), which was
   incomplete — an allowlist is strictly safer because unknown/future schemes are
   denied by default.
2. **Connect-level websocket timeout** — `connectToTarget` is now wrapped with a
   5-second `withTimeout`, so a stale or unreachable CDP endpoint fails fast (504)
   instead of hanging until a command-level timeout fires.
3. **DOM.getDocument depth reduced** — `findNode` now calls `DOM.getDocument` with
   `depth: 0` (document root node only) instead of `depth: -1` (full DOM tree).
   `DOM.querySelector` only needs `root.nodeId`, so the full tree was unnecessary
   serialization overhead.
4. **Websocket closed on connect-timeout** — when `withTimeout` wins the race in
   `connectToTarget`, the underlying websocket was previously left open with
   listeners attached. A `.catch()` on the `withTimeout` call now calls `ws.close()`
   before re-throwing, cancelling a pending connection or closing one that
   completed after the deadline.
5. **Websocket closed on connect-error** — the `error` event handler in
   `connectToTarget` now calls `ws.close()` before calling `reject()`, ensuring the
   socket is explicitly released on the early-error path (not left to GC).

## Caveats / known limitations (honest, by design)

- Page actions target **the first open page tab**, not a tracked "active"
  one — see "On active tab" above. Multi-tab targeting is Milestone 3+ work.
- Each action opens its own websocket connection and closes it when done.
  This is simpler and more robust than a long-lived session (no reconnect
  logic, no staleness across navigations), at the cost of a small per-request
  connection overhead — an acceptable, boring trade for V1.
- `click` clicks the geometric center of an element's content box. This
  matches how a human mouse click works and is what most automation tools do,
  but it will miss elements that are covered by an overlay at their center
  point (CDP has no built-in "is this point clickable" check without adding
  more machinery).
- `type` uses `Input.insertText`, which inserts the whole string at once
  (like an IME / paste) rather than dispatching one key event per character.
  It is real synthesized input — sites see an `input` event and the value
  change — but it does not exercise per-keystroke handlers (e.g. autocomplete
  that listens to `keydown`). That refinement can come later if a real use
  case needs it.

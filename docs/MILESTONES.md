# Milestones

## Milestone 0 — Repo + spec
- [x] Create repo
- [x] Write README
- [x] Write build-ready spec
- [x] Write architecture notes
- [x] Write review workflow

## Milestone 1 — Chrome attach proof
Goal: prove the Windows-hosted service can attach to real Chrome and report healthy state.

Deliverables:
- [x] Chrome path discovery
- [x] CDP endpoint discovery / validation
- [x] Attach or launch logic
- [x] `GET /health`
- [x] `GET /tabs`
- [x] Basic logs

Acceptance:
- [x] Service can report attached Chrome state reliably
- [x] Service sees real tab list in visible Chrome

## Milestone 2 — Page actions
Goal: allow basic control of the real browser.

Deliverables:
- [x] `POST /page/goto`
- [x] `POST /page/click`
- [x] `POST /page/type`
- [x] `GET /page/url`
- [x] `GET /page/text`
- [x] `GET /page/snapshot`

Acceptance:
- [x] Agent can navigate and act in visible Chrome
- [x] Actions work on a logged-in site without cookie import hacks
- [x] Final hardening pass closed and independently reviewed

## Milestone 3 — Shared control
Goal: make human + agent handoff safe and explicit.

Detailed docs:
- `docs/MILESTONE_3_CHECKLIST.md`
- `docs/STATE_TRANSITIONS.md`

Deliverables:
- [x] `POST /control/pause`
- [x] `POST /control/resume`
- [x] `GET /control/state`
- [x] basic state store
- [x] human activity timestamp tracking
- [x] explicit state machine enforcement

Acceptance:
- [x] Human can interrupt
- [x] Agent can resume from current visible state
- [x] State transitions are explicit and logged

Status note:
- Completed for v1 on 2026-06-07 after skeptical review plus live verification.
- Known limitation remains documented: passive takeover detection does not fire during `AGENT_ACTIVE`.
- See `docs/MILESTONE_3_CHECKLIST.md` for the detailed verified/open items.

## Milestone 4 — OpenClaw adapter
Goal: prove the first client integration.

Deliverables:
- [x] thin OpenClaw caller/client
- [x] first end-to-end demo flow
- [x] docs for setup + usage

Acceptance:
- [x] OpenClaw can drive the bridge end-to-end
- [x] Demo is repeatable

Status note:
- Completed on 2026-06-08 after skeptical review, automated tests, and live verification from Windows PowerShell against the real bridge + Chrome/CDP lane.
- Important environment note: the default adapter base URL works from Windows where the bridge listens on `127.0.0.1:7820`; WSL requires explicit routing to the Windows host if you want the same demo to run there unchanged.
- See `docs/MILESTONE_4_BUILD_1.md` for the concrete Build 1 surface, runtime requirements, and live verification notes.

## Milestone 5 — Hardening
Goal: make the repo publishable.

### Build 1 — Local-first guardrails

Deliverables:
- [x] localhost-only default guardrails
- [x] token option
- [ ] better error handling
- [x] test coverage for core flows
- [x] publishable README examples

Acceptance:
- [x] Repo is understandable and safe enough to share publicly

Status note:
- Build 1 completed on 2026-06-08 after builder pass, skeptical review, one narrow README honesty correction, and final PASS.
- Landed in `ac38ee2` (`Implement M5 Build 1 optional API token and hardening docs`).
- Scope stayed intentionally small: optional `BRIDGE_API_TOKEN`, localhost-first posture preserved, focused server/auth tests, and clearer README/setup guidance.
- Important honesty note: loopback binding reduces remote exposure by default, but does not prevent other local processes on the same machine from calling the bridge.

### Build 2 — Error-shape and operator clarity

Goal:
Make failures easier to debug without changing the project’s local-first scope or turning the bridge into a larger framework.

Target deliverables:
- [x] normalize API error response shape across route failures
- [x] document the main operator-visible failure modes (`DETACHED`, `PAUSED`, `ERROR`, auth failure, bad route/input)
- [x] add focused tests for representative 4xx/5xx paths
- [x] tighten README/docs examples around expected failure responses where useful

Acceptance:
- [x] Common failure modes return predictable JSON structure and status codes
- [x] A new developer can tell the difference between auth failure, bad input, paused state, detached state, and internal error without reading source first
- [x] Changes stay small and do not expand into retries, rate limiting, remote deployment posture, or a larger auth system

Status note:
- Build 2 completed on 2026-06-08 after repeated skeptical review and several narrow correction passes that closed repo-wide docs/code/test honesty gaps.
- Landed in `f04e68e` (`Implement M5 Build 2 error-shape normalization`).
- Scope stayed intentionally small: normalized error codes/shapes across representative auth, server, tabs, page, control, and handoff failure paths; focused tests; and clearer README failure-response guidance.
- Final review outcome: PASS after `/tabs` normalization and the missing `BODY_TOO_LARGE` plus representative `/tabs` failure coverage were added.

## Milestone 6 — Observable state + drift introspection

Goal: two narrow improvements to resume observability — add `expectedTitle`/`currentTitle` fields to the `TARGET_DRIFT` drift object, and introduce a dedicated `MISSING_BASELINE` code replacing overloaded `STATE_CONFLICT` for the missing-baseline resume case.

### Build 2 — Recovery-path confidence

Goal: tighten representative hard resume/recover paths so the bridge behaves predictably under stale, broken, or mid-flight-changing browser/session conditions.

Target deliverables:
- [x] focused tests for representative hard recovery/resume edge cases
- [x] verify the bridge does not claim readiness when page/session reality is broken
- [x] docs reflect only what was actually verified

Acceptance:
- [x] resume with stored targetTab but no live session returns STATE_CONFLICT, and the route attempts no transition write
- [x] adoptCurrentTarget when all tabs disappear returns NO_PAGE_TARGET, and the route calls `transition('ERROR')`
- [x] superseded recover (state changes during CDP success) returns STATE_CONFLICT, and the stale `setAttached` write is suppressed
- [x] superseded recover (state changes during CDP failure) returns STATE_CONFLICT instead of CDP_ERROR, and the stale `setAttachError` write is suppressed
- [x] recover from DETACHED (not only ERROR) with no page target returns NO_PAGE_TARGET, and the route calls `setAttachError(...)`

Status note:
- Build 2 completed on 2026-06-09. No code bugs found; all five cases were untested paths in existing correct code.
- New test file: `tests/recovery-confidence.test.js` (5 tests). Introduces `makeSpyStore` and `makeShiftingSpyStore` — spy-enabled doubles that record mutator invocation/suppression, enabling assertions on route write decisions (not just response body shape).
- Each test asserts on a store mutator call in addition to the HTTP response:
  - "stays PAUSED": `transition` call count is zero — no state write attempted on the blocking path.
  - "returns ERROR response + writes ERROR transition" (adoptCurrentTarget / NoPageTargetError): `transition` was called exactly once with `'ERROR'`.
  - "superseded recover (CDP success)": `setAttached` was not called — stale write suppressed.
  - "superseded recover (CDP failure)": `setAttachError` was not called — stale error-write suppressed.
  - "recover from DETACHED / no page target": `setAttachError` was called exactly once.
- 63/63 tests pass across all test files.
- No retries, auto-healing, orchestration, or policy engine added.
- What remains intentionally unproven: persisted real-store state after mutation (the concrete in-memory store is not exercised here), concurrent timing at the OS thread level, and any recovery paths not enumerated above.

### Build 3 — Focused-tab trust / active target semantics

Goal: investigate whether true focused/foreground tab detection is technically available for the Windows Chrome + WSL bridge setup, and implement the smallest honest improvement based on what is actually possible.

Investigation outcome:
- CDP's HTTP `/json/list` surface has no concept of focused tab. The ordering is browser-internal and not guaranteed to reflect human focus. This is a fundamental characteristic of the CDP HTTP API — not a bug in the implementation.
- CDP WebSocket `Target.targetInfoChanged` events do not expose human tab-focus changes.
- JavaScript `document.hasFocus()` evaluation via WebSocket CDP per-tab would work but requires establishing WebSocket connections to every tab — a larger architectural change not in scope.
- **Outcome B (honest fallback)** was selected. True focused-tab detection is not technically clean or reliable through the current HTTP-only CDP setup.

Target deliverables:
- [x] investigate real focused/foreground tab detectability for this setup
- [x] document the limitation honestly in code, STATE_TRANSITIONS.md, and README
- [x] add `adoptTargetId` to `POST /control/resume` — explicit target selection by CDP tab id
- [x] add `availableTargets` array to `TARGET_DRIFT` response — full tab list without extra round-trip
- [x] add `TARGET_NOT_FOUND` error code with `availableTargets` in body when `adoptTargetId` id is missing
- [x] focused tests for new paths (8 tests in `tests/focused-target.test.js`)
- [x] update existing drift-check tests to use `listTabs` mock (the path now uses `listTabs` instead of `getFirstPageTarget`)

Acceptance:
- [x] `adoptTargetId` with a valid id resumes and records that specific tab as the new baseline
- [x] `adoptTargetId` with an unknown id returns `TARGET_NOT_FOUND` with `availableTargets`, stays PAUSED
- [x] `TARGET_DRIFT` response now includes `availableTargets` array
- [x] `adoptTargetId` is mutually exclusive with `adoptCurrentTarget` and `force`
- [x] docs state explicitly that focused-tab detection is not available via CDP HTTP
- [x] docs describe the explicit `GET /tabs` → `adoptTargetId` workflow as the reliable alternative

Status note:
- Build 3 completed on 2026-06-09. Investigation confirmed Outcome B — honest fallback.
- Correction applied (post-review): `adoptTargetId` was missing from `src/adapters/openclaw.js` `resume()` despite being documented as the reliable explicit workflow. The parameter is now wired through, and the adapter test for `pause` / `resume` field serialization was extended to cover it.
- No retries, no auto-healing, no fake focus detection added.
- Builder reported 71/71 tests passing across all test files. New file: `tests/focused-target.test.js` (8 tests). The `adoptTargetId` serialisation path is covered by an extended assertion in `tests/openclaw-adapter.test.js`. Independent re-review in this sandbox could not re-run the full suite because localhost test-server binds return `EPERM` here.
- What is proven: server-side `adoptTargetId` semantics (via `tests/focused-target.test.js`); adapter correctly serialises `adoptTargetId` into the request body (via `tests/openclaw-adapter.test.js`).
- What remains intentionally unproven: round-trip adapter→server integration with `adoptTargetId` (no combined integration test); true focused-tab detection (requires Chrome extension or per-tab WebSocket `document.hasFocus()` polling, both out of scope for this build).

### Build 1 — Structured drift and recovery observability

Target deliverables:
- [x] add `expectedTitle`/`currentTitle` to the `TARGET_DRIFT` `drift` object
- [x] introduce `MISSING_BASELINE` code (replaces overloaded `STATE_CONFLICT` for the missing-baseline resume case)
- [x] focused tests for representative drift/recovery-info cases
- [x] docs: explain new fields and operator guidance table

Acceptance:
- [x] representative drift/recovery blocking responses expose useful structured fields
- [x] clients do not need to rely only on parsing human-readable error strings
- [x] state/conflict/drift distinctions remain clear
- [x] focused tests cover representative cases; existing behavior still passes
- [x] docs explain new fields honestly and briefly

Status note:
- Build 1 completed on 2026-06-08; test file covers the two new M6 semantics (title fields in TARGET_DRIFT, MISSING_BASELINE) plus one pre-existing NO_PAGE_TARGET-during-resume path included for completeness.
- Scope: two narrow `control.js` changes (title fields in `TARGET_DRIFT` `drift` object; `MISSING_BASELINE` code replacing overloaded `STATE_CONFLICT`); one focused test file (`tests/drift-recovery.test.js`, 7 tests: title fields including `null` fallback, `MISSING_BASELINE` block and force bypass, contrast showing `MISSING_BASELINE` does not fire without prior agent action, and `NO_PAGE_TARGET` during resume verification); README error-codes table updated and "Drift and recovery introspection" operator guidance section added.
- Pre-existing recover-route assertions were removed from the M6 test file — `chrome` and `targetTab` in the recover success payload existed before this milestone.
- 58/58 tests pass across all test files.
- No retries, no auto-healing, no orchestration added.

## Milestone 7 — Explicit target workflow hardening

Goal: make the honest multi-tab workflow easier to use, easier to verify, and easier for future operators/agents to understand without inventing focused-tab behavior that does not exist.

Target deliverables:
- [x] add a small `/tabs` usability improvement exposing the stored baseline target id
- [x] close the narrow proof gap around `adoptTargetId` store writes
- [x] add focused route tests for the `/tabs` response shape and error paths
- [x] create a canonical operator/agent guide for real multi-tab use
- [x] align repo docs/spec wording with the honest baseline-target semantics

Acceptance:
- [x] operators can inspect open tabs and see the stored baseline target id without an extra state round-trip
- [x] `adoptTargetId` proof covers the representative write/no-write paths that M6 left unproven
- [x] one canonical guide explains the target model, runtime setup, safe workflow, and limitations clearly enough for future agents/operators
- [x] repo wording no longer implies true active/focused-tab awareness where none exists

Status note:
- Completed on 2026-06-09 after builder pass, skeptical review, and one narrow correction pass for trust alignment.
- New canonical reference: `docs/SHARED_BROWSER_OPERATOR_GUIDE.md`.
- `/tabs` now returns `baselineTargetId` — the stored baseline target id — not a live/focused/current tab signal.
- New test file: `tests/tabs-route.test.js` (6 tests). `tests/focused-target.test.js` gained two spy-store tests proving `adoptTargetId` writes the chosen target on success and performs no state write on `TARGET_NOT_FOUND`.
- The skeptical review correctly rejected the first pass because `currentTargetId` and leftover “active tab” wording implied stronger semantics than the bridge really has; the correction pass renamed the field to `baselineTargetId` and aligned the spec.
- What is proven: `/tabs` response shape and representative error paths; the narrow `adoptTargetId` write/no-write behavior under success and `TARGET_NOT_FOUND`; the canonical operator guide and README/spec language are internally aligned on baseline semantics.
- What remains intentionally unproven/out of scope: true focused-tab detection; broader adapter→server integration coverage for `adoptTargetId`; any architecture beyond the explicit-target workflow hardening.

## Milestone 8 — Real operator demo + integration proof

Goal: add one narrow, repeatable proof lane for the explicit-target workflow so future operators/agents can run a concrete demo instead of manually assembling curl calls.

Target deliverables:
- [x] add one primary demo script for explicit target selection
- [x] keep the proof action read-oriented and low-risk
- [x] add focused tests for the demo script behavior
- [x] point README/operator guide to the demo as the main practical proof flow
- [x] document the proof limitations honestly

Acceptance:
- [x] operators/agents can run one repeatable proof flow for `GET /tabs` → target selection → `adoptTargetId` → post-adoption safe read
- [x] PASS requires deterministic selection and a successful adopt response confirming `adoptedTarget.id`
- [x] docs do not imply that the post-adoption read proves the adopted tab itself was read in multi-tab situations
- [x] the build stays small and does not expand into focused-tab architecture or broader orchestration

Status note:
- Completed on 2026-06-09 after builder pass, skeptical review, and one narrow correction pass for proof honesty.
- New primary artifact: `scripts/demo-explicit-target-flow.mjs`.
- New test file: `tests/demo-explicit-target-flow.test.js` (19 tests).
- The skeptical review correctly rejected the first pass because the proof wording overclaimed what the read step demonstrated, the script could PASS without `adoptedTarget`, and token support had drifted into the shared adapter surface. The correction pass made missing `adoptedTarget` a hard FAIL, moved token handling local to the script, and tightened README/operator-guide wording.
- What is proven: deterministic target selection; successful explicit adoption confirmed by matching `adoptedTarget.id` in the resume response; successful post-adoption safe read; the script behavior across representative success/failure branches.
- What remains intentionally unproven/out of scope: that `GET /page/url` read the adopted tab specifically in multi-tab setups; any true focused-tab awareness; live end-to-end execution in this sandbox without a real running bridge + Chrome.

## Milestone 9 — Live proof + operator playbook closure

Goal: convert the first successful real live run of the explicit-target demo lane into durable repo truth.

### Live run

The explicit-target demo script was executed successfully against a real Windows Chrome session via the WSL bridge lane (Windows PowerShell terminal).

**Live bridge command:**
```powershell
wsl bash -lc "cd /home/adamd/.openclaw/workspace/shared-browser-bridge && CDP_HOST=172.22.96.1 node src/index.js"
```

**Live demo command:**
```powershell
wsl bash -lc "cd /home/adamd/.openclaw/workspace/shared-browser-bridge && node scripts/demo-explicit-target-flow.mjs --match-url example.com"
```

**Observed results:**
- Script reported: PASS
- Selected target: title `Example Domain`, url `https://example.com/`, id `5B2AF0C8F91ABF5D5077FEBC7BFC3D59`
- `verify adoption`: `adoptedTarget.id` matched the intended tab id
- `read/url`: returned `https://example.com/`
- Bridge initially attached with a messy baseline (`chrome://intro/`); passively drifted to `PAUSED`; the explicit adopt flow resumed and succeeded from that state

**What the live run confirms:**
- Deterministic URL-match tab selection against a real CDP tab list
- Successful `resume({ adoptTargetId })` with `adoptedTarget.id` matching the intended tab in the response body
- Successful `GET /page/url` post-adoption read
- Explicit adopt succeeding from `PAUSED`, reached via passive drift on a messy initial baseline (`chrome://intro/`)

**What remains intentionally unproven:**
- That `GET /page/url` read the adopted tab specifically in a multi-tab setup (the post-adoption read returns the first CDP-listed target; the script states this limitation explicitly)
- True focused/foreground tab detection (not available via CDP HTTP)
- Broad live proof across multiple sites, multi-tab arrangements, or other operator environments

Status note:
- Completed on 2026-06-09. No code changes were required — M9 is purely documentation and live-proof capture.
- The live run confirmed that the demo script ran to PASS and explicit-target adoption succeeded in the Windows Chrome + WSL bridge lane.
- The operator guide Section 4 was updated with the Windows PowerShell `wsl bash -lc` command path for repeatability.

## Milestone 10 — OpenClaw-native integration polish

Goal: reduce friction between "the bridge works" and "an OpenClaw agent can use it naturally, safely, and repeatedly in real work."

Target deliverables:
- [x] add missing adapter methods: `text()`, `snapshot()`, `click()`, `type()` — completing the full page-action surface
- [x] add tests for the new adapter methods (validation + serialization)
- [x] create `docs/OPENCLAW_AGENT_QUICKSTART.md` — concise agent-facing guide answering the four canonical integration questions
- [x] update README with "For OpenClaw agents" section pointing to the quickstart
- [x] fix `demo-openclaw-flow.mjs` startup resume from `force: true` to `adoptCurrentTarget: true`
- [x] update the demo test to match the corrected resume behavior

Acceptance:
- [x] an OpenClaw agent can call the full page-action surface through the adapter (no raw HTTP calls needed for text, snapshot, click, type)
- [x] the recommended explicit-target sequence is documented in one concise agent-facing doc
- [x] the four canonical integration questions are answered directly: how to talk to the bridge, what the explicit-target workflow is, what to do under drift/ambiguity, and what the polished usage path is
- [x] the M4 demo no longer uses `force: true` for resume (now uses the honest `adoptCurrentTarget`)
- [x] all existing tests still pass; new tests cover the added adapter surface

Status note:
- Completed on 2026-06-09.
- Key gap closed: `src/adapters/openclaw.js` previously exposed only `health`, `tabs`, `goto`, `url`, `pause`, `resume`, `state`, `recover` — omitting `text`, `snapshot`, `click`, and `type` which all existed on the server. Without these, an OpenClaw agent could navigate but could not read page content or interact. M10 completes the adapter surface.
- New file: `docs/OPENCLAW_AGENT_QUICKSTART.md` — answers the four canonical questions directly in agent-first terms with a complete method table, recommended 8-step sequence, and blocking-code handling examples.
- `scripts/demo-openclaw-flow.mjs`: startup normalize resume changed from `force: true` to `adoptCurrentTarget: true`. The M4 demo now uses the honest recommended path instead of the force bypass.
- Tests: 5 new tests in `tests/openclaw-adapter.test.js` cover `click()` and `type()` validation (selector empty, text type) and body serialization including empty-text edge case.
- What was verified directly in the M10 honesty correction pass: `npm test` → 104 pass, 0 fail (re-run confirmed); adapter serialization for all 4 new methods; client-side validation errors thrown before network call.
- What was improved only at docs/example level: the quickstart doc and README pointer; no live bridge run in this session.
- What remains intentionally unproven: round-trip adapter → server integration for text/snapshot/click/type (no combined integration test); live end-to-end execution without a real running bridge + Chrome.
- What is out of scope: true focused-tab detection; Chrome extension integration; focus-aware architecture.

## Milestone 11 — Inspect a chosen tab and return a structured page brief

Goal: build one narrow, repeatable, OpenClaw-native workflow that selects a tab explicitly, inspects it safely, and returns a structured page brief — making the bridge feel like a real product rather than a transport demo.

Target deliverables:
- [x] primary M11 artifact: `scripts/demo-openclaw-page-brief.mjs`
- [x] workflow sequence: `health()` → `state()` → recover if needed → `tabs()` → deterministic selection → `pause()` → `resume({ adoptTargetId })` → verify adoption → `url()` + `text()` → structured brief
- [x] structured brief output: `{ ok, target: { id, title, url }, page: { readUrl, textLength, excerpt, notes } }`
- [x] brief printed as delimited JSON block to stdout alongside human-readable progress
- [x] honest `notes` array embedded in every brief describing read limitations
- [x] focused tests in `tests/demo-openclaw-page-brief.test.js` (28 tests)
- [x] docs: `OPENCLAW_AGENT_QUICKSTART.md` references the new workflow as the canonical M11 artifact

Acceptance:
- [x] workflow selects a tab by `--target-id`, `--match-url`, or `--match-title`
- [x] adoption is verified by matching `adoptedTarget.id`; missing or mismatched id is a hard FAIL
- [x] `url()` and `text()` are called as read-only inspection steps
- [x] structured brief contains target identity + page excerpt + honest notes about read limitations
- [x] excerpt collapses whitespace and truncates to 500 chars with ellipsis marker
- [x] multi-tab sessions get an additional note explaining that `url()` and `text()` both read the first CDP-listed target
- [x] all 132 tests pass (104 prior + 28 new) — builder-local verification; sandbox blocked by EPERM on server-bind tests

Status note:
- Completed on 2026-06-09.
- New primary artifact: `scripts/demo-openclaw-page-brief.mjs`.
- New test file: `tests/demo-openclaw-page-brief.test.js` (28 tests).
- Brief shape: `{ ok, target: { id, title, url }, page: { readUrl, textLength, excerpt, notes } }`. No model-driven summarization — excerpt is raw page text, whitespace-collapsed.
- Design choice: `text()` only (not `snapshot()`). The accessibility tree snapshot adds size and parsing complexity without meaningfully improving the excerpt. `text()` is sufficient for a compact, honest read-only brief.
- The `notes` field is intentional: it embeds the limitation (CDP first-listed target) directly into the brief so agents consuming the JSON see the caveat without consulting separate docs.
- What was verified directly: 28 page-brief unit tests (mock-adapter, no server bind) pass in this session; prior 104 tests pass builder-local only (server-bind tests return EPERM in this sandbox). Brief structure assertions, excerpt truncation and whitespace collapse, multi-tab note presence/absence, and all failure paths verified in session.
- What remains intentionally unproven: live bridge + Chrome execution without a real running session; that `text()` reads the adopted tab in a multi-tab setup (documented as a known limitation in brief notes and workflow output); that `snapshot()` would improve brief quality for specific page types.
- What is out of scope: model-driven summarization; `snapshot()`-based briefs; true focused-tab detection; broader workflow orchestration.

## Milestone 12 — Fix live page-read websocket runtime

Goal: fix the real runtime blocker that prevented live `GET /page/text` and `GET /page/snapshot` from working in the long-lived bridge process, then re-run the live M11 workflow honestly.

Target deliverables:
- [x] root-cause investigation against the real bridge runtime, not just mocked/unit paths
- [x] minimal runtime fix in `src/cdp/page.js`
- [x] explicit websocket implementation fallback added for bridge runtimes where `globalThis.WebSocket` is unavailable
- [x] regression test for the missing-global-WebSocket case
- [x] live verification of `GET /page/text`
- [x] live verification of `GET /page/snapshot`
- [x] live re-run of `scripts/demo-openclaw-page-brief.mjs`

Acceptance:
- [x] bridge no longer depends solely on Node exposing `globalThis.WebSocket`
- [x] page reads use `globalThis.WebSocket ?? WsWebSocket`
- [x] focused regression test proves `withPage()` still works when `globalThis.WebSocket` is unavailable
- [x] live `/page/text` returns 200 after bridge restart
- [x] live `/page/snapshot` returns 200 after bridge restart
- [x] live M11 page-brief flow completes successfully after the fix
- [x] closeout remains honest that explicit adoption does not change the first-CDP-target read limitation

Status note:
- Completed on 2026-06-09.
- Root cause: the long-lived bridge runtime could not rely on `globalThis.WebSocket` being present, even though one-off repros and local route-level repros worked.
- Fix: add `ws` as an explicit dependency and use `globalThis.WebSocket ?? WsWebSocket` in `withPage()` inside `src/cdp/page.js`.
- New regression test: `tests/page-websocket-fallback.test.js` proves the page runtime still works when `globalThis.WebSocket` is deliberately unset.
- What was verified directly in this session: live `GET /page/text` returned 200 with `{\"ok\":true,\"text\":\"\"}`; live `GET /page/snapshot` returned 200 with `{\"ok\":true,\"snapshot\":[]}`; live `scripts/demo-openclaw-page-brief.mjs --match-url example.com` completed successfully and ended with clean handoff to `PAUSED`.
- Local regression evidence: `tests/page-websocket-fallback.test.js` passed and specifically proved the missing-`globalThis.WebSocket` fallback path. Broader server-binding test slices are sandbox-sensitive (`EPERM` on `127.0.0.1`) and are therefore not used here as the primary proof for M12.
- Honest live outcome: the workflow now runs successfully, but its read result still reflects the first CDP-listed target (`chrome://newtab/`) rather than the explicitly adopted `https://example.com/`, which is the expected and documented limitation.
- What remains intentionally unproven: a clean reproducible rerun of the broader server-binding test slice in every sandbox context; full suite rerun beyond the new regression + live checks; any guarantee that page reads reflect the explicitly adopted tab in multi-tab setups; any improvement to focused-tab awareness.
- What is out of scope: changing the first-CDP-target semantics; focus-aware architecture; extension work; broader workflow redesign.

## Milestone 13 — Bind page reads to the explicitly adopted target

Goal: determine whether `url()`, `text()`, and `snapshot()` can be made to operate on the explicitly adopted target (the tab recorded via `adoptTargetId` or `adoptCurrentTarget` at resume time) rather than whatever `getFirstPageTarget()` returns.

### Investigation result

The fix is possible and was implemented. The blocking gap was entirely architectural: `withPage()` always called `session.getFirstPageTarget()` regardless of what was stored in `store.targetTab`. The adopted target id (`store.getState().targetTab?.id`) was available at every page route but never consulted. CDP's `/json/list` surface (`listPageTargets()`) already returns full target objects including `webSocketDebuggerUrl` for every tab, so lookup-by-id required no new network surface.

A secondary issue: the handoff guard's post-action baseline update also called `getFirstPageTarget()`, which would overwrite `targetTab.id` back to the first-listed tab after every successful page operation. This was fixed in the same pass so that successive reads stay bound to the adopted target.

### Changes made

- `src/cdp/session.js`: added `getTargetById(id)` — queries `listPageTargets()`, finds the matching target by id, throws `NoPageTargetError` if not found
- `src/cdp/session-slot.js`: added `getTargetById` proxy to forward to the current session
- `src/cdp/page.js`: `withPage()` now accepts a `{ targetId }` option; when provided and non-null, calls `session.getTargetById(targetId)` instead of `session.getFirstPageTarget()`
- `src/api/routes/page.js`: all six page routes (`url`, `text`, `snapshot`, `goto`, `click`, `type`) now read `store.getState().targetTab?.id` and pass it as `targetId`; `urlRoute` uses `session.getTargetById` directly (no WebSocket needed for URL reads)
- `src/guards/handoff.js`: post-action baseline update now uses `session.getTargetById(targetTab.id)` when an adopted target is recorded, so the adopted tab persists as the baseline across successive operations; falls back to `getFirstPageTarget()` when no adoption exists

## Milestone 14 — LinkedIn follow-up operator proof

Goal: prove the first real startup wedge for the bridge — reliable LinkedIn post-follow-up and interaction support for a solo founder/operator using a trusted browser session.

Primary user:
- solo startup owner/operator with limited time

Primary in-house proof lane:
- AI Optimizer LinkedIn first

Target deliverables:
- [x] deterministic LinkedIn follow-up inspection workflow
- [x] structured follow-up brief for a chosen LinkedIn post/page context
- [ ] narrow safe interaction workflow (`inspect`, `draft`, and/or clearly bounded `act` mode)
- [x] operator docs explaining the proven workflow and its limits
- [x] honest live proof on the AI Optimizer LinkedIn lane

Acceptance:
- [x] bridge can reliably reach the intended LinkedIn context in the trusted browser session
- [x] workflow returns a structured follow-up brief useful for deciding what to do next
- [x] workflow is proven on the AI Optimizer LinkedIn lane
- [x] docs state clearly what is actually proven vs not yet proven

Status note:
- Planned on 2026-06-10 as the next deliberate milestone.
- Detailed plan lives in `docs/M14_LINKEDIN_FOLLOWUP_OPERATOR_PROOF.md`.
- This is intentionally the wedge, not a broad all-social milestone.
- Build 1 live proof passed on 2026-06-11; see `docs/M14_LIVE_TEST_REPORT_2026-06-11.md` and `docs/WINDOWS_CDP_PORTPROXY_SETUP.md`.

### M14 Build 2 — LinkedIn post/thread inspection + draft-prep lane

Goal: deepen M14 from generic LinkedIn follow-up inspection into a more specific owned-post/thread workflow, while staying read-first and non-public by default.

Planned deliverables:
- [ ] deterministic selection of a narrower LinkedIn owned-post or thread context when available
- [ ] richer follow-up brief fields oriented around post/thread review, not just generic feed text
- [ ] bounded draft-preparation lane for comment/reply candidates with no public submission
- [ ] docs explaining the draft-prep boundary clearly

Acceptance:
- [ ] workflow can inspect a more specific post/thread context than the generic feed when that context is available
- [ ] draft suggestions are generated without crossing into public action
- [ ] inspect-vs-draft boundary stays explicit and honest

Status note:
- Planned immediately after the successful M14 Build 1 live proof.
- Keep this narrow: no public submit path, no broad interaction automation, no platform expansion.
- Builder spec lives in `docs/M14_BUILD_2_POST_THREAD_DRAFT_PREP_SPEC.md`.

## Milestone 15 — LinkedIn interaction reliability hardening

Goal: make the M14 interaction lane trustworthy enough for repeated real use without constant operator anxiety.

Planned deliverables:
- [ ] clearer failure classification for interaction paths
- [ ] safer retries / verification where honest
- [ ] cleaner approval boundary for draft-vs-act decisions
- [ ] stronger docs around safe repeated use

Acceptance:
- [ ] repeated use feels operationally trustworthy, not fragile
- [ ] interaction failures are understandable and bounded
- [ ] approval/act boundaries stay explicit

Status note:
- Planned as the follow-on hardening pass after M14 proof.
- Keep this narrow; do not turn it into broad platform expansion.

## Milestone 16 — X second-platform adaptation

Goal: port the proven follow-up/interactions model from LinkedIn to X without pretending universal platform support.

Planned deliverables:
- [ ] adapt the proven workflow to X
- [ ] keep the same honest structured brief model where possible
- [ ] document platform-specific limits and differences

Acceptance:
- [ ] X becomes the second proven platform for the same narrow wedge
- [ ] docs stay explicit about what is shared vs platform-specific

Status note:
- Planned only after LinkedIn proof + hardening are real.
- This should remain a second-platform extension, not a rush to every network.

## Milestone 17 — Multi-brand routing

Goal: support a small owned-brand set with the already-proven workflow.

Planned rollout order:
- [ ] AI Optimizer primary
- [ ] occasional Adam profile support
- [ ] occasional Day Place support
- [ ] Prompt to Process after branding is ready

Acceptance:
- [ ] workflow can be reused across a small owned-brand set without losing clarity or trust
- [ ] routing and operator expectations remain simple

Status note:
- Placeholder milestone only for now.
- Do not activate until earlier platform reliability is honestly proven.
- `tests/adopted-target-reads.test.js`: 6 regression tests (new file)

### What is proven

- `url()` calls `getTargetById` with the adopted id, not `getFirstPageTarget`, and returns that tab's URL — proven by test 1 (explicit call-site assertion)
- `url()` falls back to first-target semantics when `targetTab` is null — proven by test 2
- `text()` connects to the adopted tab's CDP WebSocket (not the first-listed tab's), and returns that tab's text — proven by test 3 (two real mock WS servers, distinct response content)
- `text()` falls back to first-target when no adoption — proven by test 4
- `snapshot()` connects to the adopted tab's CDP WebSocket — proven by test 5
- When the adopted tab has been closed after adoption, `text()` returns `NO_PAGE_TARGET` with a 409 — proven by test 6
- The new M13 regression file proves the adopted-target read path directly. A broader full-suite/pass-count claim is intentionally not made here.

### What remains intentionally unproven

- `goto`, `click`, and `type` were also updated to use the adopted target id (same pattern), but no dedicated M13 tests cover them — the correctness of the mechanism is shared with `text()` and `snapshot()` which are tested
- The post-action baseline update path in `handoff.js` is not exercised by the new tests (the mock store's `transition()` is a no-op, so the guard does not enter AGENT_ACTIVE, and the baseline update block is not reached); the fix is correct but verified only by code review, not by a test that exercises the full guard state machine

### No longer true after M13

The following statements in earlier milestone notes are now outdated:
- "the post-adoption read returns the first CDP-listed target" (M8, M9, M11, M12 notes) is no longer true for `url()`, `text()`, and `snapshot()` when an adopted target is recorded.
- The M11 page-brief note about first-listed-target reads became stale after this change and was removed from the script/test wording in this pass.

Status note:
- Completed on 2026-06-09. Root cause was confirmed by code trace before any implementation. Fix was narrow: 5 source files, ~40 lines added or changed. 6 new regression tests were added for adopted-target read behavior.
- Live proof rerun completed on 2026-06-10 against a real three-tab Chrome session (`Feed | LinkedIn`, `Example Domain`, `AI Optimizer`). `resume({ adoptTargetId })` returned the intended LinkedIn tab id `70CFAC685C15F58674A08B281A170F77`; `GET /page/url` returned `https://www.linkedin.com/feed/`; `GET /page/text` returned 5052 chars with excerpt content clearly from the signed-in LinkedIn feed. This closes the prior live-proof gap for adopted-target page reads.
- No focused-tab detection, no Chrome extension work, no long-lived WebSocket orchestration, no retries, no broad refactor.
- The fix is honest: when `targetTab` is null (no adoption recorded), all routes fall back to first-target semantics exactly as before.

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

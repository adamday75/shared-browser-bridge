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

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
- [ ] `POST /control/pause`
- [ ] `POST /control/resume`
- [ ] `GET /control/state`
- [ ] basic state store
- [ ] human activity timestamp tracking
- [ ] explicit state machine enforcement

Acceptance:
- [ ] Human can interrupt
- [ ] Agent can resume from current visible state
- [ ] State transitions are explicit and logged

## Milestone 4 — OpenClaw adapter
Goal: prove the first client integration.

Deliverables:
- [ ] thin OpenClaw caller/client
- [ ] first end-to-end demo flow
- [ ] docs for setup + usage

Acceptance:
- [ ] OpenClaw can drive the bridge end-to-end
- [ ] Demo is repeatable

## Milestone 5 — Hardening
Goal: make the repo publishable.

Deliverables:
- [ ] localhost-only default guardrails
- [ ] token option
- [ ] better error handling
- [ ] test coverage for core flows
- [ ] publishable README examples

Acceptance:
- [ ] Repo is understandable and safe enough to share publicly

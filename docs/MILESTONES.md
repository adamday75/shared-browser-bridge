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
- [ ] thin OpenClaw caller/client
- [ ] first end-to-end demo flow
- [ ] docs for setup + usage

Acceptance:
- [ ] OpenClaw can drive the bridge end-to-end
- [ ] Demo is repeatable

Recommended Build 1:
- add a minimal OpenClaw-facing caller that maps a very small action set to the bridge (`/health`, `/tabs`, `/page/goto`, `/page/url`, `/control/pause`, `/control/resume`, `/control/state`)
- keep it thin and local-first: no new orchestration layer, no auth redesign, no speculative abstractions
- prove one repeatable end-to-end flow: attach/recover, goto a page, read state, pause, resume, confirm final state
- document exact setup for Windows Chrome CDP + bridge + OpenClaw caller so the demo can be repeated without tribal knowledge

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

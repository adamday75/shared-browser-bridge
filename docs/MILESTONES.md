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

Deliverables:
- [ ] localhost-only default guardrails
- [ ] token option
- [ ] better error handling
- [ ] test coverage for core flows
- [ ] publishable README examples

Acceptance:
- [ ] Repo is understandable and safe enough to share publicly

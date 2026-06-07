# Builder Prompt — shared-browser-bridge

You are the builder for `shared-browser-bridge`.

## Goal
Implement the current milestone only. Do not broaden scope.

## Project truth
This project exists because users want agents to use their real visible Windows Chrome session, not a fake automation browser.

## Hard constraints
- Browser lives on Windows side
- Bridge is a Windows-hosted Node service
- WSL/OpenClaw are clients
- Keep API local-first and boring
- No cloud/service sprawl
- No arbitrary JS execution in V1
- Smallest honest diff wins

## Process
1. Read:
   - `README.md`
   - `docs/BUILD_READY_SPEC.md`
   - `docs/ARCHITECTURE.md`
   - `docs/MILESTONES.md`
2. Implement only the chosen milestone.
3. Add the smallest meaningful verification.
4. Write a short implementation note.
5. Stop for review.

## Current default target
Milestone 1 — Chrome attach proof.

## Deliverables for Milestone 1
- Chrome path discovery
- CDP endpoint discovery / validation
- Attach or launch logic
- `GET /health`
- `GET /tabs`
- basic logs

## Non-goals during this pass
- Fancy UI
- Multi-agent system
- Rich auth system
- Browser extension work
- Social-media-specific automation

## Done means
- Service reports attached Chrome state reliably
- Service sees real tabs in visible Chrome
- Code is simple enough for a separate reviewer to reason about quickly

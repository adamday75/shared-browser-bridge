# Milestone 3 — Shared Control Implementation Checklist

## Goal
Make human + agent handoff safe, explicit, and reliable.

This milestone is where the bridge stops being just a browser action layer and becomes a real shared-control system.

## Core outcome
The user can:
- let the agent act in the real visible Windows Chrome
- interrupt safely at any time
- pause agent control explicitly
- resume agent control from the last observed agent page-target baseline

## Required deliverables

### 1. Control endpoints
- [x] `POST /control/pause`
- [x] `POST /control/resume`
- [x] `GET /control/state`

### 2. State machine implementation
- [x] `DETACHED`
- [x] `ATTACHED`
- [x] `AGENT_ACTIVE`
- [x] `HUMAN_ACTIVE`
- [x] `PAUSED`
- [x] `ERROR`

### 3. State store
- [x] current state persisted in memory
- [x] last successful attach metadata
- [x] last observed agent page-target baseline metadata
- [x] last agent action timestamp written on agent-driven routes
- [x] last human activity timestamp written on explicit manual control routes
- [x] pause reason / error reason fields

### 4. Transition rules
- [x] explicit transition guards
- [x] invalid transitions rejected cleanly
- [ ] human authority overrides agent authority — passive detection covers ATTACHED; blind spot during AGENT_ACTIVE remains (see §5 note)
- [x] uncertain state prefers pause over blind action for resume checks
- [x] explicit adopt-current-target path on resume when drift is detected

### 5. Human activity detection
Start simple.

- [x] explicit manual pause path works first
- [x] bridge records recent human activity timestamp when possible
- [x] define what counts as human takeover for v1 — passive tab drift (first page target id or url changed vs. stored agent baseline) while ATTACHED
- [ ] no silent fighting between human and agent — covered for ATTACHED state; AGENT_ACTIVE blind spot: takeover during an in-flight agent action is not yet detected in real time

> **v1 detection note:** The poller samples CDP `/json/list` every 2 s while `controlState === 'ATTACHED'` or `'PAUSED'` with a stored target baseline. Drift detection (tab/url comparison → `PAUSED` transition) only fires during `ATTACHED`. During `PAUSED` the poll runs for connectivity only — if CDP disconnects or the page target disappears, the bridge transitions to `ERROR` rather than claiming a usable paused state. Drift detection is intentionally disabled during `AGENT_ACTIVE` because the agent itself drives navigation and we cannot distinguish the two sources without real-time CDP WebSocket input events.

### 6. Agent action gating
- [x] actions blocked while `PAUSED`
- [x] actions blocked or rejected while `HUMAN_ACTIVE`
- [x] overlapping agent actions rejected while `AGENT_ACTIVE`
- [x] resume requires a fresh browser-state check after prior agent activity by default; `{"force":true}` explicitly bypasses this check and accepts the risk of stale state

### 7. Recovery behavior
- [x] clean error when browser disconnects
- [x] clean error when target tab disappears
- [x] `ERROR -> ATTACHED` recovery path
- [x] `ERROR -> DETACHED` cleanup path
- [x] stale recover cannot undo an explicit detach — ownership re-checked on both the success and failure paths after async CDP work; if state changed, the route returns 409 without touching bridge state

### 8. Logging / observability
- [x] log state transitions
- [x] log pause/resume events
- [x] log takeover events — `[takeover] passive-tab-drift (...)` + `lastTakeover` in GET /control/state
- [x] log rejected actions with reason

### 9. Verification targets
- [x] agent acts, then pauses successfully — live-verified on 2026-06-07: `page/goto` succeeded in `ATTACHED`, `POST /control/pause` moved to `PAUSED`, and later `page/goto` was rejected while paused
- [x] human interrupts without agent fighting back — live-verified on 2026-06-07: manual tab drift moved `ATTACHED -> PAUSED` with `passive-takeover-detected` and `lastTakeover` populated
- [x] resume works from changed page state — live-verified on 2026-06-07: plain resume rejected observable drift, then `{"adoptCurrentTarget":true}` resumed cleanly and updated the baseline
- [ ] tab switch during pause does not corrupt state
- [x] disconnect produces honest error state — live-verified on 2026-06-07: closing the debug Chrome profile while `PAUSED` moved the bridge to `ERROR` with a surfaced CDP failure; consistent with resume and recovery route behavior

## Recommended implementation order

### Phase A — explicit pause/resume
- [x] implement `/control/pause`
- [x] implement `/control/resume`
- [x] implement `/control/state`
- [x] add basic state store
- [x] block page actions when paused

### Phase B — state machine enforcement
- [x] centralize transition logic
- [x] add transition validation
- [x] add transition logging

### Phase C — human takeover behavior
- [x] define v1 observable-target drift heuristic for resume safety
- [x] record human activity timestamp on explicit manual control routes
- [x] explicit `adoptCurrentTarget` path on resume: accepts new observable baseline, not a blind override
- [x] move to `PAUSED` when passive takeover is detected — poller samples CDP every 2 s during `ATTACHED`; `HUMAN_ACTIVE` not used because source cannot be confirmed as human (see §5 note)

### Phase D — recovery
- [x] browser disconnect recovery path
- [x] target tab invalidation path
- [x] startup seeds initial target baseline or enters ERROR if no page tab exists — poller can detect drift from first ATTACHED tick
- [x] post-action baseline race fixed: baseline updated while in AGENT_ACTIVE, before ATTACHED transition; baseline write is also state-gated — a pause landing during the post-action target fetch is discarded, so post-pause browser reality cannot overwrite the baseline
- [x] stale in-flight recover cannot undo a concurrent explicit detach/reset — ownership re-checked after async CDP work completes on both the success path (before `setAttached`) and the failure path (before `setAttachError`); if state changed, the route returns 409 without touching bridge state
- [x] resume from fresh page state — live-verified on 2026-06-07 via observable drift rejection plus explicit `adoptCurrentTarget` resume to a fresh baseline

## Acceptance criteria
Milestone 3 is done when:
- the bridge no longer just issues actions blindly
- a human can interrupt and the bridge yields safely
- resume works from the last observed agent page-target baseline or an explicit adopted target
- state transitions are explicit and logged
- failures are honest, not silent

## Non-goals for Milestone 3
- fancy GUI
- multi-user arbitration
- cloud sync
- rich permissions system
- full activity replay timeline

## Why this matters
This milestone is the foundation for reliable social media upkeep and any other real account maintenance. Without shared-control discipline, the bridge is just another automation toy. With it, the bridge becomes trustworthy.

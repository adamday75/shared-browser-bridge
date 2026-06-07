# Milestone 3 — Shared Control Implementation Checklist

## Goal
Make human + agent handoff safe, explicit, and reliable.

This milestone is where the bridge stops being just a browser action layer and becomes a real shared-control system.

## Core outcome
The user can:
- let the agent act in the real visible Windows Chrome
- interrupt safely at any time
- pause agent control explicitly
- resume agent control from the current real browser state

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
- [ ] current target tab metadata
- [x] last agent action timestamp (field exists, not yet written)
- [x] last human activity timestamp (field exists, not yet written)
- [x] pause reason / error reason fields

### 4. Transition rules
- [x] explicit transition guards
- [x] invalid transitions rejected cleanly
- [ ] human authority overrides agent authority
- [ ] uncertain state prefers pause over blind action

### 5. Human activity detection
Start simple.

- [x] explicit manual pause path works first
- [ ] bridge records recent human activity timestamp when possible
- [ ] define what counts as human takeover for v1
- [ ] no silent fighting between human and agent

### 6. Agent action gating
- [x] actions blocked while `PAUSED`
- [ ] actions blocked or rejected while `HUMAN_ACTIVE`
- [ ] actions allowed in `AGENT_ACTIVE`
- [ ] actions require fresh state check before resume

### 7. Recovery behavior
- [ ] clean error when browser disconnects
- [ ] clean error when target tab disappears
- [ ] `ERROR -> ATTACHED` recovery path
- [ ] `ERROR -> DETACHED` cleanup path

### 8. Logging / observability
- [ ] log state transitions
- [ ] log pause/resume events
- [ ] log takeover events
- [ ] log rejected actions with reason

### 9. Verification targets
- [ ] agent acts, then pauses successfully
- [ ] human interrupts without agent fighting back
- [ ] resume works from changed page state
- [ ] tab switch during pause does not corrupt state
- [ ] disconnect produces honest error state

## Recommended implementation order

### Phase A — explicit pause/resume
- [x] implement `/control/pause`
- [x] implement `/control/resume`
- [x] implement `/control/state`
- [x] add basic state store
- [x] block page actions when paused

### Phase B — state machine enforcement
- [ ] centralize transition logic
- [ ] add transition validation
- [ ] add transition logging

### Phase C — human takeover behavior
- [ ] define v1 takeover heuristic
- [ ] record human activity timestamp
- [ ] move to `HUMAN_ACTIVE` or `PAUSED` when takeover is detected

### Phase D — recovery
- [ ] browser disconnect recovery path
- [ ] target tab invalidation path
- [ ] resume from fresh page state

## Acceptance criteria
Milestone 3 is done when:
- the bridge no longer just issues actions blindly
- a human can interrupt and the bridge yields safely
- resume works from current browser reality
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

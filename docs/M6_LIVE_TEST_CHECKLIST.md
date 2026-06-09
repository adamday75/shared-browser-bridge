# Milestone 6 Live Test Checklist

Use this after M6 Build 1 + Build 2 to validate real browser behavior with a human at the computer.

Date prepared: 2026-06-09
Relevant commits:
- `fdd3ba2` — M6 Build 1 drift observability
- `5924192` — M6 Build 2 recovery confidence

## Goal
Validate the real attach / pause / resume / recover paths in a live visible Chrome session.

## Test setup
Before starting:
- run the bridge normally
- use a real visible Chrome/Chromium session
- keep notes on pass/fail + exact response bodies
- if a case fails, capture the exact endpoint used and returned `code`

---

## 1) Clean attach
### Steps
- start from detached / clean state
- attach to the target browser
- confirm bridge reports attached state

### Expect
- attach succeeds
- control state becomes attached
- target tab info looks sane

---

## 2) Manual pause from attached
### Steps
- while attached, call pause
- verify bridge enters paused state

### Expect
- pause succeeds
- control state becomes `PAUSED`
- no weird drift/error codes

---

## 3) Normal resume with same target still present
### Steps
- while paused, leave the target tab alone
- resume normally

### Expect
- resume succeeds
- state returns to attached
- no drift/conflict error

---

## 4) Resume after target drift
### Steps
- pause
- change the tab enough to create real drift (navigate elsewhere, swap tab, or otherwise change the expected page identity)
- attempt normal resume

### Expect
- resume blocks
- response should clearly expose drift info
- if applicable, confirm `TARGET_DRIFT` payload includes the structured fields added in M6 Build 1
- confirm the drift response is understandable enough to act on

---

## 5) Resume when the original target disappears
### Steps
- pause
- close the original tab or otherwise remove the saved target
- attempt normal resume

### Expect
- resume fails honestly
- should not silently reattach as if everything is fine
- expect a blocking response such as `NO_PAGE_TARGET` or another truthful conflict path depending on exact route conditions

---

## 6) Resume with missing live verification path
### Steps
- create a case where the bridge has stored target context but lacks the live session needed to verify it
- attempt resume

### Expect
- bridge blocks instead of guessing
- should return the missing-baseline / conflict-style safety behavior introduced in M6
- should not fake a healthy resume

---

## 7) Recover from broken/error state with usable page target
### Steps
- create a recoverable broken state
- run recover

### Expect
- recover succeeds only if CDP + page validation really succeed
- state returns to attached only on real success
- target tab info is refreshed correctly

---

## 8) Recover when no page target exists
### Steps
- create an error or detached state where recover is allowed
- ensure there is no usable page target
- run recover

### Expect
- recover fails honestly
- expect `NO_PAGE_TARGET`
- should not claim attached/healthy state

---

## 9) Recover after interference / mid-flight mess
### Steps
- start a recover scenario
- during or around that window, create interference if safely possible (detach/reset/change state)

### Expect
- bridge should not let stale recovery silently win
- if state changed mid-flight, expect conflict-style protection rather than fake success

---

## 10) Sanity pass on operator usefulness
For any blocking case above, check:
- is the returned `code` useful?
- is the `controlState` truthful?
- is the payload actionable enough for a human/operator?
- does it avoid vague generic failure language?

---

## Pass criteria
Good outcome:
- normal attach / pause / resume works
- drift is surfaced clearly
- missing target / broken recovery cases fail honestly
- recover only succeeds on real validated recovery
- stale or messy state does not silently win

## If a case fails
Capture:
- scenario name
- exact step where it failed
- endpoint called
- returned HTTP status
- returned `code`
- returned body
- what the real browser state looked like

That failure becomes the candidate for the next build.

# Milestone 6 Live Test Report — 2026-06-09

## Status
DONE_WITH_CONCERNS

## Summary
M6 Build 1 + Build 2 passed the initial live checks for attach, pause, and normal resume. The main live finding was a semantics gap around tab switching: switching to a different focused tab while paused did **not** trigger `TARGET_DRIFT`, and resume returned to `ATTACHED` cleanly.

This turned out not to be a random failure. The current implementation does **not** track the true human-focused/foreground tab. It compares the stored `targetTab` baseline against CDP's **first page target**. That is narrower than the user expectation of "follow or notice the focused tab I actually switched to."

## Environment notes
- Windows Chrome remote debugging worked on port `9222`
- In this session, WSL could **not** reach Windows Chrome on `127.0.0.1:9222`
- WSL **could** reach Windows Chrome on the Windows host IP from `/etc/resolv.conf`: `172.22.96.1`
- Successful bridge startup for live testing required:
  - Windows Chrome launched with `--remote-debugging-port=9222`
  - WSL bridge launched with `CDP_HOST=172.22.96.1`

## Root cause findings
### 1) WSL/Windows loopback assumption failed in this session
Symptom:
- Bridge started from WSL reported no CDP endpoint at `http://127.0.0.1:9222`
- Python from WSL to `127.0.0.1:9222/json/version` returned connection refused
- Python from WSL to `172.22.96.1:9222/json/version` succeeded

Conclusion:
- For this live session, WSL could not use Windows loopback for CDP and needed the Windows host IP explicitly.

### 2) Drift behavior is narrower than focused-tab behavior
Symptom:
- After pause, Adam switched to other tabs/pages
- `POST /control/resume` still returned `{ ok: true, controlState: "ATTACHED" }`
- Bridge logs showed repeated `PAUSED -> ATTACHED` + `manual-resume`
- No `TARGET_DRIFT` responses were observed

Code-level explanation:
- `src/cdp/session.js` documents that CDP's HTTP `/json/list` surface has no concept of focused tab
- `getFirstPageTarget()` returns the first open page target
- `src/api/routes/control.js` resume drift guard compares stored `targetTab` against `session.getFirstPageTarget()`
- Therefore, switching the human-focused tab is **not guaranteed** to count as drift

Conclusion:
- Current M6 drift protection is honest only as **first-page-target drift detection**, not true focused-tab drift detection

## What passed live
### Test 1 — Clean attach
PASS
- Bridge reached `ATTACHED`
- `targetTab` was populated
- `chrome.endpoint` reflected the corrected CDP host

### Test 2 — Manual pause
PASS
- `POST /control/pause` returned success
- state became `PAUSED`

### Test 3 — Normal resume
PASS
- `POST /control/resume` returned success
- state returned to `ATTACHED`

## What did not pass as originally expected
### Test 4 — Drift after focused tab change
FAILED_AS_EXPECTATION_MISMATCH
- User expectation: switching to a different focused tab/page while paused should either follow focus or block resume with `TARGET_DRIFT`
- Actual behavior: resume succeeded normally
- Reason: implementation watches first page target, not the true focused/foreground tab

## Product interpretation
If the product promise is:
- "use the browser I am actually looking at"

then the current behavior is a real gap.

If the product promise is only:
- "preserve a narrower bridge-selected target unless explicitly changed"

then current behavior is more defensible, but weaker and less intuitive than the user expectation.

## Recommended next step
Create Milestone 6 Build 3 around **focused-tab trust / active target semantics**.

## Evidence / relevant files
- `src/cdp/session.js`
- `src/api/routes/control.js`
- `docs/STATE_TRANSITIONS.md`
- `docs/M6_LIVE_TEST_CHECKLIST.md`

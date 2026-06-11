# Milestone 14 Build 1 Live Test Report — 2026-06-11

## Status
DONE

## Summary
M14 Build 1 passed a real live proof against a signed-in Windows Chrome LinkedIn session using the WSL-hosted `shared-browser-bridge`.

The important outcome is not just that transport worked. The bridge attached to the real browser, enumerated the real LinkedIn tab, adopted the selected target explicitly, read the adopted page URL/text successfully, produced the structured LinkedIn follow-up brief, and returned the bridge to `PAUSED` cleanly.

This is the first honest live proof that the LinkedIn follow-up inspection wedge is real for AI Optimizer.

## Environment notes
- Windows host: Chrome 149 on Windows, launched with a non-default user-data-dir due to Chrome's March 2025 remote-debugging restriction on the default profile
- WSL bridge host: `/home/adamd/.openclaw/workspace/shared-browser-bridge`
- Bridge URL: `http://127.0.0.1:7820`
- Working CDP route from WSL: `http://172.22.96.1:9223`
- LinkedIn surface used in the proof: `https://www.linkedin.com/feed/`

## Root cause findings from the live run

### 1) Chrome remote debugging no longer worked on the default profile
Symptom:
- Launching Chrome with only `--remote-debugging-port=9222` did not expose a reachable CDP endpoint
- Windows PowerShell `Invoke-WebRequest http://127.0.0.1:9222/json/version` failed repeatedly

Conclusion:
- On this machine/session, Chrome required a non-default `--user-data-dir` for remote debugging to take effect

### 2) WSL could not use Windows loopback directly for CDP
Symptom:
- Windows PowerShell could reach `http://127.0.0.1:9222/json/version`
- WSL could not reach either `127.0.0.1:9222` or `172.22.96.1:9222`

Conclusion:
- A Windows-only CDP listener was not enough for the WSL bridge lane

### 3) Port proxy + firewall opening were required for the WSL bridge lane
Symptom:
- After adding a Windows `portproxy` from `0.0.0.0:9223` to `127.0.0.1:9222`, WSL still initially could not reach the forwarded endpoint
- After opening the Windows firewall rule for TCP 9223, WSL `curl http://172.22.96.1:9223/json/version` succeeded

Conclusion:
- The working live path for this machine is:
  - Chrome on Windows exposes CDP on `127.0.0.1:9222`
  - Windows portproxy exposes that on `0.0.0.0:9223`
  - Windows firewall allows inbound TCP 9223
  - WSL bridge attaches with `CDP_HOST=172.22.96.1 CDP_PORT=9223`

## What passed live

### Test 1 — Bridge attach to real Windows Chrome
PASS
- Bridge attached to existing CDP endpoint at `http://172.22.96.1:9223`
- State transitioned `DETACHED -> ATTACHED`
- Initial target baseline was the real LinkedIn feed tab

### Test 2 — Explicit target enumeration + adoption
PASS
- `GET /tabs` returned the live LinkedIn tab
- The M14 script selected the tab deterministically with `--match-url "linkedin.com"`
- `resume({ adoptTargetId })` succeeded and returned the adopted target id

### Test 3 — Read-only LinkedIn follow-up inspection
PASS
- `GET /page/url` returned `https://www.linkedin.com/feed/`
- `GET /page/text` returned 7158 chars of live page text
- Structured LinkedIn follow-up brief JSON was produced successfully

### Test 4 — Clean handoff back to operator
PASS
- Workflow ended by pausing the bridge again
- Final state returned to `PAUSED`

## Live output highlights
- Selected target title: `Feed | LinkedIn`
- Selected target id: `668E8040365157E34E99C4A09B62728E`
- Read URL: `https://www.linkedin.com/feed/`
- Visible signals result:
  - `commentsPresent: true`
  - `commentBoxesVisible: false`
  - `replyAffordancesVisible: false`
  - `interactionOpportunities: 1`

## What this proof honestly establishes
- The Windows Chrome + WSL bridge lane is workable on this machine
- M14 Build 1 can inspect a real signed-in LinkedIn context through the trusted browser model
- Explicit target selection and adoption semantics hold up in live use
- The structured follow-up brief is real, not only test-suite real

## What this proof does not establish
- No public mutation path was tested
- No commenting/replying/posting flow was tested
- Signal extraction is still heuristic page-text matching, not DOM-verified extraction
- This proof used the LinkedIn feed surface, not a deeper owned-post comment thread surface

## Recommended next step
Proceed to M14 Build 2 as a narrow deepening pass:
- keep the workflow read-first
- move from generic feed inspection toward a more specific post/thread context when available
- add a bounded draft-preparation lane without public submission

## Evidence / relevant files
- `docs/M14_BUILD_1_LINKEDIN_FOLLOWUP.md`
- `docs/M14_LINKEDIN_FOLLOWUP_OPERATOR_PROOF.md`
- `scripts/demo-linkedin-followup-brief.mjs`
- `tests/demo-linkedin-followup-brief.test.js`

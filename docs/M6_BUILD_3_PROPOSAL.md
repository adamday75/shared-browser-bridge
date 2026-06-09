# Milestone 6 Build 3 Proposal — Focused-Tab Trust / Active Target Semantics

## Why this build exists
Live testing on 2026-06-09 showed that switching to a different focused tab while paused did **not** trigger `TARGET_DRIFT`. Resume succeeded because the bridge currently compares the stored baseline against CDP's **first page target**, not the true human-focused tab.

That is honest relative to the current implementation, but it is not the behavior Adam expects from a shared visible browser controller.

## Product question
When the user changes tabs while the bridge is paused, what should resume mean?

This build should answer that explicitly.

## Recommended product rule
**Recommended default:** block and explain.

If the currently focused/foreground tab differs from the stored target baseline:
- do **not** silently follow it
- do **not** silently resume on the old target
- return a structured blocking response
- allow an explicit adopt path

### Why this is the right default
- safest ownership model
- avoids silent target jumps
- matches the user's mental model of a visible shared browser
- keeps human control explicit

## Proposed behavior
### During paused resume
If the focused/foreground tab differs from the stored baseline:
- return `TARGET_DRIFT` (or a tighter successor code if needed)
- include structured fields for:
  - expected target
  - current focused target
  - whether the difference is tab-id, url, or both
- keep state at `PAUSED`

### Explicit opt-in path
Allow:
- `{"adoptCurrentTarget": true}`

to accept the currently focused tab as the new baseline and resume.

### Forced override
Retain:
- `{"force": true}`

for explicit skip-all-checks behavior.

## Scope for Build 3
### Build exactly this
- define a real focused/foreground target signal for live Chrome use if technically feasible
- wire resume drift checks to that signal instead of plain first-page-target ordering
- add focused-tab drift tests
- update docs to describe the semantics honestly
- preserve explicit `adoptCurrentTarget` behavior

### Do not build
- retries/backoff
- auto-healing/orchestration
- multi-target workflow engine
- background tab inventory reconciliation
- auth/network changes
- broad refactor of page actions

## Technical investigation targets
Before coding, answer these:
1. Can CDP expose a reliable active/foreground target for this browser mode?
2. If not directly, can we derive it from a better signal than `/json/list` ordering?
3. If true focus detection is not reliable, should the bridge instead expose explicit target selection as the next honest model?

## Fallback if true focused-tab detection is not technically clean
If CDP cannot provide a clean focus signal, the honest alternative is:
- explicit target selection / adoption
- better docs stating the bridge operates on a chosen target, not automatically on the human-focused tab
- possibly a route to inspect/select a target deterministically

## Acceptance ideas
- pausing on tab A, switching to tab B, then resuming blocks with structured drift info
- `adoptCurrentTarget` after switching to tab B resumes successfully and records B as the new baseline
- normal resume still succeeds when the focused tab has not changed
- docs clearly distinguish focused-tab semantics from mere tab-list ordering

## Recommendation
Build 3 should start as an **investigate-first** milestone, not an implementation guess.

Reason:
The key question is whether true focused-tab detection is technically available and stable enough through CDP for the visible Windows Chrome setup. If yes, implement it. If not, pivot quickly to the honest explicit-target model instead of faking focus awareness.

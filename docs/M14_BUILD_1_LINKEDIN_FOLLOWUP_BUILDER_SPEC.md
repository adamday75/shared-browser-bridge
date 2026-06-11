# M14 Build 1 — LinkedIn Follow-up Read Proof (Builder Spec)

## Mission

Implement the first executable slice of Milestone 14 for `shared-browser-bridge`:

> Prove a reliable **read-only LinkedIn follow-up workflow** for AI Optimizer using the trusted browser/session model.

This is **not** a generic browser-automation task.
This is **not** a broad social-media abstraction task.
This is **not** an acting/comment-posting milestone yet.

The goal is to produce one honest, repeatable proof artifact that can inspect a chosen LinkedIn context and return a structured follow-up brief useful for deciding what to do next.

---

## Scope

### In scope
- one primary script for LinkedIn follow-up inspection
- explicit target selection using the repo’s proven bridge semantics
- read-only inspection flow
- structured output brief
- failure evidence capture for blocked/ambiguous states
- focused tests for the script behavior
- concise supporting doc for running the proof

### Out of scope
- posting automation
- autonomous commenting/replying
- multi-platform support
- stealth/evasion work
- cookie-vault architecture
- major server architecture changes unless clearly required by an actual blocker
- inventing focused-tab semantics the repo has already explicitly rejected

---

## Required artifact

Create:
- `scripts/demo-linkedin-followup-brief.mjs`

Create tests:
- `tests/demo-linkedin-followup-brief.test.js`

Create doc:
- `docs/M14_BUILD_1_LINKEDIN_FOLLOWUP.md`

Update any canonical index/guide docs only if needed and only honestly.

---

## Functional requirements

The script must:

1. connect through the existing OpenClaw adapter / bridge path already used by prior demo scripts
2. check health/state first
3. perform honest recovery only if needed
4. inspect available tabs/targets
5. deterministically choose the LinkedIn target using explicit selection rules
6. pause / resume with explicit target adoption when appropriate
7. verify adoption from the resume response
8. perform read-only inspection of the chosen LinkedIn context
9. emit a structured follow-up brief
10. exit with clear PASS/FAIL semantics

---

## Selection requirements

Support a deterministic target-selection path using one or more of:
- `--target-id`
- `--match-url`
- `--match-title`

If multiple plausible LinkedIn tabs exist and the selection is ambiguous, the script must FAIL honestly rather than guessing.

---

## Output requirements

The script should print human-readable progress, but it must also emit a machine-usable JSON block.

Suggested shape:

```json
{
  "ok": true,
  "target": {
    "id": "...",
    "title": "...",
    "url": "..."
  },
  "followUp": {
    "surface": "linkedin",
    "postContext": {
      "readUrl": "...",
      "title": "..."
    },
    "visibleSignals": {
      "commentsPresent": false,
      "commentBoxesVisible": false,
      "replyAffordancesVisible": false,
      "interactionOpportunities": 0
    },
    "suggestedMode": "inspect_only",
    "notes": [],
    "limitations": []
  }
}
```

The exact field names can vary if there is a good repo-local reason, but the output must remain:
- structured
- deterministic
- useful
- honest about limitations

---

## Read-only rule

This build is **read-only**.
Do not click submit buttons, post comments, publish anything, or mutate public LinkedIn state.
If a possible implementation path risks public action, stop and choose the safer path.

---

## Failure evidence requirements

On representative failure/ambiguity paths, capture enough evidence to debug what happened.
Keep this small and honest.

Possible evidence fields/artifacts:
- selected target metadata
- current bridge state
- read URL/title
- excerpt or visible text summary
- explicit error code / reason
- optional screenshot/snapshot only if it fits the current repo style cleanly

Do not overbuild a giant diagnostics framework.

---

## Technical principles

1. **Use the real trusted session model** already established in this repo.
2. **Use explicit target semantics**; do not imply focused-tab awareness.
3. **Use strict bounded waits** where needed.
4. **Prefer deterministic failure over fuzzy success.**
5. **Keep retries narrow** and only for transient UI/readiness conditions.
6. **Keep docs aligned to what is actually proven.**

---

## Likely implementation shape

Before coding, inspect the existing demo scripts and choose the smallest extension path rather than inventing a new architecture.

Likely relevant existing artifacts:
- `scripts/demo-openclaw-page-brief.mjs`
- `scripts/demo-explicit-target-flow.mjs`
- `docs/OPENCLAW_AGENT_QUICKSTART.md`
- `docs/SHARED_BROWSER_OPERATOR_GUIDE.md`
- `docs/M14_LINKEDIN_FOLLOWUP_OPERATOR_PROOF.md`

Strong preference:
- reuse proven adapter/workflow patterns
- keep the new script consistent with existing demo style

---

## Acceptance criteria

Builder should consider Build 1 complete only if:

- a repeatable script exists
- target selection is deterministic and honest
- adoption verification is enforced
- output brief is genuinely useful for deciding the next operator action
- the script is read-only
- tests cover representative success/failure branches
- docs explain how to run it and what it proves

This build is **not complete** if the outcome is merely “browser connection still works.”

---

## Non-scope guardrails

Do not expand into:
- M14 Build 3 draft generation
- controlled public interaction proof
- X support
- generalized social abstraction
- deep server refactors unless required by a demonstrated blocker

---

## Delivery expectation

Please make the code/doc/test changes directly in the `shared-browser-bridge` repo, keep the scope tight, and report back with:
- what files changed
- what the script does
- what is honestly proven
- what remains unproven
- whether tests were run and with what result

When completely finished, run this command to notify me:
openclaw system event --text "Done: M14 Build 1 LinkedIn follow-up read proof builder pass finished" --mode now

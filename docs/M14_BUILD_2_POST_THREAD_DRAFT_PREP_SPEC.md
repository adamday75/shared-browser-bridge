# M14 Build 2 — LinkedIn Post/Thread Inspection + Draft-Prep (Builder Spec)

## Mission

Implement the next narrow slice after the successful M14 Build 1 live proof:

> Move from generic LinkedIn feed inspection toward a more specific owned-post / comment-thread inspection workflow, and add a bounded draft-preparation lane without public submission.

This is still a trust-building milestone, not a public-action milestone.

## Why this build exists

Build 1 proved the real browser lane works:
- real Windows Chrome attach
- explicit LinkedIn target adoption
- read-only URL/text inspection
- structured follow-up brief generation

But the live proof was still on the generic LinkedIn feed surface.

The next useful step is to make the workflow more operator-relevant by:
- targeting a narrower owned-post or thread context when available
- extracting more useful review signals
- preparing candidate reply/comment drafts without posting them

## Scope

### In scope
- deterministic inspection of a narrower LinkedIn post/thread context when available
- a structured brief shaped for follow-up review, not just generic feed reading
- optional draft-preparation mode that outputs candidate reply/comment text only
- strict no-submit / no-public-action behavior
- focused tests covering representative success/failure cases
- concise docs explaining the safe boundary

### Out of scope
- clicking submit/post/reply buttons
- autonomous public commenting
- approval/execution of real public actions
- broad platform expansion
- deep architecture changes unless a demonstrated blocker requires them

## Required artifacts

Create or extend as needed:
- script support for narrower post/thread inspection and draft-prep behavior
- focused tests
- a concise supporting doc for how Build 2 is run and what it proves

Preferred path:
- extend the existing M14 Build 1 script if that keeps the repo simpler
- only split into a new script if the mode boundary becomes confusing

## Functional requirements

The Build 2 workflow must:

1. reuse the proven bridge + explicit-target path from Build 1
2. inspect a narrower LinkedIn context than a generic feed when that context is available
3. fail honestly if the selected tab/context is too ambiguous
4. keep read-only inspection as the base mode
5. support a draft-prep mode that emits candidate follow-up text without public submission
6. preserve an explicit and visible boundary between `inspect_only` and `draft_only`
7. return structured output useful for operator review

## Suggested modes

- `inspect_only`
  - read the page/thread context
  - return structured signals and recommendations

- `draft_only`
  - do everything from `inspect_only`
  - additionally emit one or more candidate reply/comment drafts
  - never click, type into submit flows, or publish

Build 2 must not introduce an `act` mode.

## Suggested output shape

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
    "contextType": "feed|post|thread",
    "postContext": {
      "readUrl": "...",
      "title": "...",
      "textLength": 1234,
      "excerpt": "..."
    },
    "visibleSignals": {
      "commentsPresent": true,
      "commentBoxesVisible": false,
      "replyAffordancesVisible": true,
      "interactionOpportunities": 2
    },
    "suggestedMode": "inspect_only|draft_only",
    "drafts": [
      {
        "kind": "reply_candidate",
        "text": "..."
      }
    ],
    "notes": [],
    "limitations": []
  }
}
```

Exact field names may vary if the existing script structure suggests a better local fit.

## Safety / trust rules

1. no public submission
2. no hidden mutating fallback
3. no claims of DOM precision unless DOM-backed extraction is actually implemented
4. no fake confidence about whether a thread/post is truly the operator's intended one
5. deterministic failure beats fuzzy success

## Likely implementation direction

Good candidates:
- extend selector handling and context classification in `scripts/demo-linkedin-followup-brief.mjs`
- improve heuristic/context extraction enough to distinguish feed vs narrower post/thread surfaces when observable
- add draft generation as a bounded output mode only

Do not overbuild a general social automation framework here.

## Acceptance criteria

Build 2 is complete only if:

- a narrower owned-post or thread inspection path exists when the context is available
- output becomes more useful for real follow-up review than generic feed inspection alone
- draft-prep stays clearly non-public
- tests cover representative mode and ambiguity paths
- docs remain honest about what is and is not proven

## Non-scope guardrails

Do not let this build drift into:
- public posting/replying
- approval workflow engines
- multi-platform abstraction
- broad content strategy systems
- large transport/server redesigns without a demonstrated blocker

## Delivery expectation

Report back with:
- files changed
- whether Build 2 extended the existing script or introduced a separate one
- what new operator value was added beyond Build 1
- what remains unproven
- test results

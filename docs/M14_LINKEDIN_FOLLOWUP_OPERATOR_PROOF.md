# Milestone 14 — LinkedIn Follow-up Operator Proof

## Goal

Prove that `shared-browser-bridge` can reliably support the **after-post workflow** on LinkedIn for a solo founder/operator:
- inspect a chosen owned post/page context
- check follow-up state
- inspect comments/replies/engagement context
- identify worthwhile interaction opportunities
- safely support draft-or-act follow-up behavior

This milestone is **not** about broad social automation.
It is the first narrow startup wedge for a trusted browser-based social operator.

---

## Why this milestone exists

The painful status quo is:
- official API access is blocked or delayed (LinkedIn page-management approval still pending after ~6 weeks)
- current browser options are fragile/unreliable
- solo startup owners cannot keep up with posting follow-up and interaction manually
- the real time sink is not only posting — it is ongoing interaction after the post exists

So the wedge is:

> Reliable browser-mediated LinkedIn follow-up and interaction support when APIs are blocked or too weak.

---

## First user

**Solo startup owner / operator** with limited time who needs an agent to help maintain consistent social presence.

First concrete in-house use:
- AI Optimizer LinkedIn first
- occasional Adam profile support later
- occasional Day Place later
- Prompt to Process only after branding is ready

---

## Scope

### In scope
- deterministic selection of the relevant LinkedIn post/page context in the owned browser session
- reliable read/check workflow after a post exists
- inspection of visible comments/replies/follow-up context
- structured follow-up brief returned to the operator/agent
- support for a safe interaction workflow:
  - identify follow-up opportunities
  - prepare candidate comment/reply content
  - optionally perform controlled interaction if/when the proof level allows it
- explicit proof on AI Optimizer’s LinkedIn workflow first
- honest documentation of what is truly proven

### Out of scope
- generic “all social platforms” support
- Instagram/TikTok/YouTube/Facebook/Threads support
- broad account-management platform claims
- content generation strategy itself
- full autonomous public posting across all brands
- pretending that every interaction path is production-safe before proof exists

---

## Primary acceptance question

Can Gary reliably help with the **after-post LinkedIn workflow** without requiring constant babysitting?

Not:
- “can the browser click around?”
- “can we theoretically automate social?”

But specifically:
- can it inspect the right context?
- can it surface worthwhile next actions?
- can it support safe interaction?
- can it do this repeatably enough to matter?

---

## Deliverables

Implementation-ready builder spec:
- `docs/M14_BUILD_1_LINKEDIN_FOLLOWUP_BUILDER_SPEC.md`
- `docs/M14_BUILD_2_POST_THREAD_DRAFT_PREP_SPEC.md`

### 1. LinkedIn follow-up inspection workflow
A repeatable workflow that:
- attaches to the trusted browser session
- selects the intended LinkedIn target/context explicitly
- reads the relevant post/follow-up surface
- returns a structured follow-up brief

### 2. Structured follow-up brief
A deterministic output shape for follow-up inspection.

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
    "postContext": "...",
    "visibleSignals": {
      "commentsPresent": true,
      "replyOpportunities": 2,
      "engagementHints": []
    },
    "notes": [],
    "limitations": []
  }
}
```

Exact fields can change, but the brief must stay:
- structured
- deterministic
- useful to an operator/agent
- honest about limitations

### 3. Safe interaction lane
A narrow and explicit interaction flow for follow-up actions.

Possible modes:
- inspect only
- draft only
- operator-approved act

The milestone must state clearly which mode is truly proven.

### 4. Operator guidance
Docs describing:
- what the workflow does
- how to run it
- what is safe vs not yet safe
- what still requires Adam/operator approval

---

## Acceptance

### Required acceptance
- bridge can reliably reach the intended LinkedIn context in the trusted browser session
- a repeatable follow-up inspection flow exists and returns a structured brief
- the brief is useful enough to drive a real next decision
- the workflow is proven specifically on AI Optimizer’s LinkedIn lane
- docs describe the real proven workflow and its limits honestly

### Strong acceptance
- the workflow can identify at least one real follow-up/comment opportunity from a live owned LinkedIn context
- draft-or-act boundary is explicit and safe
- repeated use does not immediately collapse into session ambiguity or operator confusion

---

## Honest stop gates

Stop M14 when one of these is reached:
- proof is achieved honestly
- a real browser/session limitation blocks further progress
- operator/live testing from Adam is required
- a risky public-action boundary requires judgment/approval
- repeated failure shows the current approach is wrong

---

## Non-goals / anti-scope-creep rules

Do **not** let M14 drift into:
- “let’s support every platform”
- “let’s turn this into a full social suite”
- “let’s generalize everything before proving LinkedIn follow-up works”
- “let’s claim reliable acting before we have reliable proof”

The wedge is narrow on purpose.

---

## What counts as honest completion

M14 is complete when:
- the LinkedIn follow-up operator flow is real and repeatable
- the proven mode is clearly stated (inspect only vs draft vs controlled act)
- the repo contains a durable proof artifact + docs
- the result is useful enough that Gary can begin carrying part of the founder social-follow-up load

If the outcome is only “browser transport still works,” M14 is **not** complete.

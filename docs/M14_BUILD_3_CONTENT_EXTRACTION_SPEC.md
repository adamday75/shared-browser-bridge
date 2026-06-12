# M14 Build 3 — LinkedIn Post/Thread Content Extraction Quality (Builder Spec)

## Mission

Improve live content extraction quality on LinkedIn post/thread pages (`/feed/update/...`, `/posts/...`) so the follow-up brief contains actually useful post and comment text — not just `"0 notifications"`.

This is still a trust-building milestone, not a public-action milestone.

## Why this build exists

Build 2 proved the workflow boundary:
- URL-based context classification (feed / post / thread / profile / unknown)
- explicit `inspect_only` vs `draft_only` mode boundary
- draft candidates generated without public submission
- live-tested on a real LinkedIn post URL

But the live test exposed a real extraction weakness:
- on a `/feed/update/...` URL, `GET /page/text` (`document.body.innerText`) returned only 15 chars (`0 notifications`)
- the workflow and boundary proof passed, but the brief's `excerpt` and `textLength` were essentially empty
- signal extraction (comments, replies, etc.) had nothing to work with

The next useful step is to make content extraction actually produce useful text when a post/thread page is loaded.

## Root cause

`GET /page/text` runs `document.body.innerText` via CDP `Runtime.evaluate`. On LinkedIn's SPA:
- post/thread content loads asynchronously after initial page render
- `innerText` called too early may return only nav/notification chrome
- dynamically loaded comments and thread content may not be in the DOM yet

The bridge also exposes `GET /page/snapshot` which queries interactive DOM elements (`a`, `button`, `input`, `h1`–`h3`, etc.) and returns their text — up to 200 elements. This captures text from rendered elements even when `innerText` is sparse.

## Scope

### In scope
- use `snapshot()` alongside `text()` to extract richer content from post/thread pages
- combine snapshot element text with innerText for a more complete extraction
- report content quality honestly: flag when extraction is sparse
- add a `contentQuality` indicator to the brief so operators know what they got
- preserve the explicit `inspect_only` / `draft_only` boundary (no changes)
- preserve fully non-public behavior (no changes)
- focused tests for snapshot-backed extraction and quality reporting

### Out of scope
- adding new bridge endpoints or CDP expressions
- retry/polling logic for async content loading
- LinkedIn-specific DOM selector targeting (e.g., querying `.feed-shared-update-v2__description`)
- any public action, submission, or mutation
- broad framework changes

## Functional requirements

Build 3 must:

1. call `snapshot()` after `text()` to get DOM element text
2. extract useful text content from snapshot elements (filtering out nav/button noise)
3. combine snapshot-derived text with `innerText` for the richest available extraction
4. add a `contentQuality` field to the brief indicating extraction richness:
   - `"rich"` — substantial text extracted (>= 200 chars of meaningful content)
   - `"partial"` — some text extracted but limited (50–199 chars)
   - `"sparse"` — very little useful text (< 50 chars)
5. add honest limitations when extraction is sparse
6. use snapshot element text for signal extraction when innerText is too sparse
7. preserve all existing Build 2 behavior when innerText is already rich

## Suggested output additions

```json
{
  "followUp": {
    "postContext": {
      "contentQuality": "rich|partial|sparse",
      "snapshotTextLength": 1234,
      "combinedExcerpt": "..."
    }
  }
}
```

The `excerpt` field continues to use innerText. A new `combinedExcerpt` captures the best available text from either source.

## Safety / trust rules

1. no public submission
2. no hidden mutating fallback
3. `snapshot()` is read-only (it queries DOM elements, does not modify them)
4. no claims of DOM precision beyond what snapshot actually provides
5. deterministic failure beats fuzzy success
6. content quality must be reported honestly

## Implementation direction

- extend `runLinkedInFollowUpBrief()` to call `adapter.snapshot()` after `adapter.text()`
- add a `extractSnapshotText()` helper that pulls meaningful text from snapshot elements
- update `buildFollowUpBrief()` to accept snapshot data and compute content quality
- use the richer text source for signal extraction when innerText is sparse
- snapshot failure should not block the workflow — degrade gracefully to text-only

## Acceptance criteria

Build 3 is complete only if:

- snapshot-backed extraction produces more useful text than innerText alone on sparse pages
- content quality is reported honestly in the brief
- signal extraction works better when innerText is sparse but snapshot has content
- all existing Build 2 tests still pass
- new tests cover snapshot extraction, quality levels, and graceful degradation
- docs remain honest about what is and is not proven

## What Build 3 does NOT prove

- that snapshot extraction will always capture the full post/thread content (LinkedIn DOM structure varies)
- that async-loaded comments will be present in the snapshot (they may not be)
- that content quality will be "rich" on every page (honest reporting matters more)
- any public action capability

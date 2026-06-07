# Review Note — Milestone 2

Reviewer: separate Claude Code review pass
Date: 2026-06-06
Status: REVISE

## Findings

1. Core Milestone 2 implementation is solid and stays aligned with the spec: real CDP websocket actions, no fake managed browser drift, and a small API surface.
2. Verification is real: goto/url/text/snapshot were exercised end-to-end against a live CDP browser.
3. Main issue: request body handling needs a size limit / defensive cap so a malformed or hostile local caller cannot stream an arbitrarily large body into memory.

## Risks

- Local memory abuse via oversized POST body.
- Mild operational fragility if route handlers assume body size is always small.

## Requested changes

1. Add a small request body size cap in `src/api/body.js` (for example ~1 MB or smaller).
2. Return a clean 413-style error when the limit is exceeded.
3. Document the cap briefly in the Milestone 2 implementation note.

## Approval status

REVISE

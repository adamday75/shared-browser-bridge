# M14 Build 1 — LinkedIn Follow-up Read Proof

## What this is

A read-only LinkedIn follow-up inspection workflow for `shared-browser-bridge`. It connects to a trusted browser session, selects a chosen LinkedIn tab, and returns a structured follow-up brief useful for deciding what to do next.

This is the first executable slice of Milestone 14 — proving reliable LinkedIn post-follow-up support for a solo founder/operator.

## How to run it

### Prerequisites

- Bridge running and attached to Chrome with at least one LinkedIn tab open
- Node.js available in the environment

### Start the bridge

```powershell
# Working live-proof lane on this machine:
# 1) Start Windows Chrome with remote debugging + non-default user-data-dir
# 2) Expose Windows CDP to WSL via portproxy/firewall on 9223
# 3) Start the bridge from WSL:
cd /home/adamd/.openclaw/workspace/shared-browser-bridge && CDP_HOST=172.22.96.1 CDP_PORT=9223 node src/index.js
```

See `docs/WINDOWS_CDP_PORTPROXY_SETUP.md` for the exact Windows + WSL setup used in the live proof.

### Run the follow-up brief

Select by URL substring:
```bash
node scripts/demo-linkedin-followup-brief.mjs --match-url "linkedin.com"
```

Select by tab title:
```bash
node scripts/demo-linkedin-followup-brief.mjs --match-title "LinkedIn"
```

Select by exact CDP target id (from `GET /tabs`):
```bash
node scripts/demo-linkedin-followup-brief.mjs --target-id <id>
```

### Options

| Flag | Purpose |
|------|---------|
| `--base-url <url>` | Bridge base URL (default: `http://127.0.0.1:7820`) |
| `--token <token>` | Bearer token if `BRIDGE_API_TOKEN` is set on the bridge |
| `--target-id <id>` | Select tab by exact CDP target id |
| `--match-url <str>` | Select the one tab whose URL contains this string |
| `--match-title <str>` | Select the one tab whose title contains this string |

Exactly one selector (`--target-id`, `--match-url`, or `--match-title`) is required. If the selector matches zero or multiple tabs, the script fails honestly.

## Workflow sequence

1. `health()` — verify bridge is reachable
2. `state()` — check current control state
3. `recover()` — only if state is `ERROR` or `DETACHED`
4. `tabs()` — enumerate open tabs
5. Deterministic target selection using the provided selector
6. `pause()` — if currently `ATTACHED` (skipped if already `PAUSED`)
7. `resume({ adoptTargetId })` — adopt the selected tab explicitly
8. Verify `adoptedTarget.id` matches the intended tab
9. `url()` + `text()` — read-only inspection of the adopted target
10. Build structured follow-up brief with visible signal extraction
11. `pause()` — hand off back to operator

## Output brief shape

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
      "title": "...",
      "textLength": 1234,
      "excerpt": "..."
    },
    "visibleSignals": {
      "commentsPresent": true,
      "commentBoxesVisible": true,
      "replyAffordancesVisible": true,
      "interactionOpportunities": 3
    },
    "suggestedMode": "inspect_only",
    "notes": ["..."],
    "limitations": ["..."]
  }
}
```

## What this proves

- Bridge reachable and responding
- `GET /tabs` enumerates open tabs with ids, URLs, and titles
- Target selected deterministically by explicit selector
- `adoptTargetId` confirmed by response body (`adoptedTarget.id` verified)
- `GET /page/url` and `GET /page/text` completed after adoption, reading the adopted target (M13 binding)
- Structured LinkedIn follow-up brief produced with heuristic visible signal extraction

## What this does NOT prove

- Signal extraction is heuristic text matching, not DOM structure analysis
- Dynamically loaded content (comments behind "show more") may be missed
- This is read-only — no mutations, comments, or public actions were performed
- Auth-gated content visibility depends on the browser session state

## Visible signal extraction

The brief includes a `visibleSignals` object with heuristic text-pattern detection:

- `commentsPresent` — page text contains comment/reply keywords
- `commentBoxesVisible` — page text contains "add a comment" or similar affordance text
- `replyAffordancesVisible` — page text contains reply/replies keywords
- `interactionOpportunities` — count of detected signal categories (0–3)

These are heuristic indicators, not DOM-verified facts. They are useful for deciding whether follow-up inspection is worthwhile, not for precise interaction targeting.

## Tests

36 focused tests in `tests/demo-linkedin-followup-brief.test.js`:

```bash
node --test tests/demo-linkedin-followup-brief.test.js
```

Coverage includes:
- Happy path with all three selector types
- Brief structure and field assertions
- Visible signal detection (rich and minimal page text)
- LinkedIn vs non-LinkedIn URL limitation handling
- Excerpt truncation at 500 chars
- Control flow variants (already PAUSED, ERROR/DETACHED recovery)
- All representative failure paths (no selector, ambiguous match, health failure, adoption rejection, read failures)
- Unit tests for `isLinkedInUrl`, `extractVisibleSignals`, and `parseArgs`

## Live proof status

Live proof is now included.

See:
- `docs/M14_LIVE_TEST_REPORT_2026-06-11.md`

The live proof established:
- attach to real Windows Chrome through the WSL bridge lane
- explicit LinkedIn target selection and adoption
- read-only LinkedIn follow-up brief generation against a real signed-in session

## Limitations

- `suggestedMode` is always `inspect_only` — this build does not support draft or act modes
- Signal extraction is text-heuristic only; DOM-aware extraction would require `snapshot()` parsing
- The script does not persist briefs or maintain state across runs
- Public mutation/comment/reply flows are still unproven

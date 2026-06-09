# State Transition Table

## States
- `DETACHED`
- `ATTACHED`
- `AGENT_ACTIVE`
- `HUMAN_ACTIVE`
- `PAUSED`
- `ERROR`

## Rule of the system
**Human authority always outranks agent authority.**

If the bridge is uncertain, it should pause or error honestly rather than continue blindly.

## Transition table

| From | To | Trigger | Allowed? | Notes |
|---|---|---|---|---|
| `DETACHED` | `ATTACHED` | successful Chrome/CDP attach | Yes | normal startup path |
| `DETACHED` | `ERROR` | attach/start failure | Yes | honest failure path |
| `ATTACHED` | `AGENT_ACTIVE` | agent starts an action sequence | Yes | bridge is connected and ready |
| `ATTACHED` | `HUMAN_ACTIVE` | human is actively using browser | Yes | passive human-first state |
| `ATTACHED` | `PAUSED` | explicit pause request | Yes | safe hold state |
| `ATTACHED` | `DETACHED` | browser disconnect / bridge stop | Yes | normal cleanup |
| `ATTACHED` | `ERROR` | invalid browser/session state | Yes | must stop honestly |
| `AGENT_ACTIVE` | `ATTACHED` | action sequence finishes | Yes | idle but still connected |
| `AGENT_ACTIVE` | `HUMAN_ACTIVE` | human takeover detected | Yes | human wins; **v1 blind spot: passive poller does not fire during AGENT_ACTIVE — this transition requires explicit signal or future real-time CDP detection** |
| `AGENT_ACTIVE` | `PAUSED` | explicit pause request | Yes | safe interruption |
| `AGENT_ACTIVE` | `ERROR` | action failure / stale target / CDP break | Yes | fail honestly |
| `AGENT_ACTIVE` | `DETACHED` | browser disconnect | Yes | hard disconnect |
| `HUMAN_ACTIVE` | `PAUSED` | explicit pause or safe-hold policy | Yes | good default if uncertain |
| `HUMAN_ACTIVE` | `ATTACHED` | human stops interacting | Yes | bridge returns to ready state |
| `HUMAN_ACTIVE` | `AGENT_ACTIVE` | explicit resume / safe resume policy | Yes | only after fresh state read |
| `HUMAN_ACTIVE` | `ERROR` | browser/session inconsistency | Yes | must stop honestly |
| `HUMAN_ACTIVE` | `DETACHED` | browser closed / bridge disconnected | Yes | cleanup |
| `PAUSED` | `HUMAN_ACTIVE` | human continues manual use | Yes | normal during pause |
| `PAUSED` | `ATTACHED` | pause lifted without immediate agent action | Yes | idle-ready state |
| `PAUSED` | `AGENT_ACTIVE` | explicit resume and action restart | Yes | must refresh state first |
| `PAUSED` | `DETACHED` | browser disconnect / bridge stop | Yes | cleanup |
| `PAUSED` | `ERROR` | invalid paused state / stale session | Yes | fail honestly |
| `ERROR` | `DETACHED` | cleanup/reset | Yes | safest default |
| `ERROR` | `ATTACHED` | successful recovery / reattach | Yes | resume only after fresh validation |
| `ERROR` | `PAUSED` | preserve connected session but freeze actions | Yes | optional safe recovery mode |

## Implemented recovery endpoints

- `POST /control/recover` — from `ERROR` or `DETACHED`, re-attach to the configured CDP endpoint, validate the endpoint, require a fresh page target, then move to `ATTACHED` with a new observable target baseline.
- `POST /control/detach` — cleanup/reset path from `ERROR` that clears the in-memory session reference and moves the bridge to `DETACHED`.

If recovery reaches Chrome but finds no open page tabs, the bridge ends in `ERROR` instead of pretending it is safely ready.

**Stale recover protection:** `POST /control/recover` captures the starting state before async CDP work begins. After async CDP work completes — whether it succeeds or fails — it re-reads state before touching bridge state. If state has changed — e.g., a concurrent `POST /control/detach` moved `ERROR → DETACHED` — the route returns 409 without any state mutation. This guard applies to both the success path (before `setAttached`) and the failure path (before `setAttachError`). Without the failure-path guard, a failed recovery could drive `DETACHED → ERROR` and silently undo the explicit reset.

## Transition priorities

### Highest priority
1. Human takeover (passive detection covers `ATTACHED` only; `AGENT_ACTIVE` is a blind spot in v1 — see passive takeover detection section)
2. Explicit pause
3. Honest error handling
4. Agent action execution

### Safety principles
- Never silently switch to a different browser.
- Never continue acting on stale assumptions after human intervention.
- By default, do not resume from cached state without re-reading browser reality. `POST /control/resume` enforces this check; `{"force":true}` is an explicit opt-out that skips the re-read and accepts the risk of resuming on stale state.
- Never hide a disconnect or state corruption event.

## Suggested state semantics

### `DETACHED`
No browser control available.

### `ATTACHED`
Bridge connected, ready, not actively driving.

### `AGENT_ACTIVE`
Bridge currently executing agent-driven actions.

### `HUMAN_ACTIVE`
Human is currently driving the browser; agent must yield.

### `PAUSED`
Connected but action execution intentionally suspended.

### `ERROR`
Unsafe or broken state; action execution must stop.

## Passive takeover detection (v1)

`src/cdp/takeover-poller.js` polls CDP `GET /json/list` every 2 s (configurable via `TAKEOVER_POLL_INTERVAL_MS`).

**Rule:** While `controlState === 'ATTACHED'` and a `targetTab` baseline exists, if the first page target's id or url has changed since the last agent action, treat it as a takeover signal and transition to `PAUSED`.

**Why PAUSED, not HUMAN_ACTIVE:** HTTP polling cannot confirm the source of the change was a human (could be an extension, service worker, or Chrome-internal navigation). `PAUSED` is the honest uncertain-hold state.

**On CDP disconnect or missing page target during polling:** the bridge transitions to `ERROR` whether the current state is `ATTACHED` or `PAUSED`. The bridge cannot honestly claim a usable attached or paused state if the underlying CDP connection or page target is gone. For `NoPageTargetError` the stored target baseline is also cleared. Drift detection (tab/url comparison) only runs during `ATTACHED`; when polled from `PAUSED` the connectivity check alone is performed — no additional state change is triggered if the connection is healthy.

**Known blind spots:**
- No detection during `AGENT_ACTIVE` — agent drives navigation itself; we cannot distinguish human from agent changes mid-action. The `AGENT_ACTIVE -> HUMAN_ACTIVE` transition therefore cannot be triggered automatically in v1.
- No detection if no `targetTab` baseline exists. At startup this is prevented: the bridge seeds an initial baseline immediately after attaching, or enters `ERROR` if no page tab is available. The blind spot can still occur if the baseline is cleared by a `NoPageTargetError` during operation.
- Polling lag up to `intervalMs` (default 2 s).
- Only checks the first page target; does not track all open tabs.
- **No focused-tab detection.** CDP's HTTP `/json/list` surface does not expose which tab the human has focused. Switching tabs without navigating or closing the baseline tab does not trigger drift detection. Use `GET /tabs` to enumerate open tabs and `{"adoptTargetId":"<id>"}` on `POST /control/resume` to explicitly select a different target.

**Post-action baseline race protection:** `handoff.js` updates the target baseline *while still in `AGENT_ACTIVE`* (before transitioning to `ATTACHED`). The poller only fires in `ATTACHED`, so it cannot misread the just-completed navigation as passive takeover because of baseline update timing. The baseline write itself is also state-gated: if a concurrent `POST /control/pause` lands during the post-action target fetch, the fetched result is discarded — post-pause browser reality is never recorded as the new baseline.

## Implementation note
Milestone 3 centralizes transition enforcement in `src/state/store.js`. All transitions go through `store.transition()` or the named helpers (`setAttached`, `setDetached`, `setAttachError`).

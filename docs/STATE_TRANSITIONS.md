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
| `AGENT_ACTIVE` | `HUMAN_ACTIVE` | human takeover detected | Yes | human wins |
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

## Transition priorities

### Highest priority
1. Human takeover
2. Explicit pause
3. Honest error handling
4. Agent action execution

### Safety principles
- Never silently switch to a different browser.
- Never continue acting on stale assumptions after human intervention.
- Never resume from cached state without re-reading browser reality.
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

## Implementation note
Milestone 3 should centralize transition enforcement in one place rather than scattering state changes across route handlers.

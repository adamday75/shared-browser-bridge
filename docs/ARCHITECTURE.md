# Architecture Notes

## Principle

The browser belongs to Windows. Agents are clients.

This project should not treat WSL as the browser host. WSL is an integration lane.
The browser bridge should live next to the real visible Chrome it controls.

## Process model

- Windows Chrome process
- Windows Node bridge service
- WSL/OpenClaw/other local clients

## Flow

1. Chrome is launched or attached on Windows with CDP available.
2. Bridge connects to Chrome.
3. Bridge exposes a tiny localhost API.
4. Agent clients call the API.
5. Human can override through direct browser use.
6. Bridge resumes from current visible state.

## Design principles

- Local-first
- Visible-first
- Real-session-first
- Small command surface
- Human override beats agent control
- Boring transport, boring auth, boring logs

## First technical bet

Use Node + Chrome DevTools Protocol directly before adding extension complexity.

That gives the fastest route to:
- attach
- inspect tabs
- navigate
- click
- type
- snapshot

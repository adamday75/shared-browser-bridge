# First Build Session

## Objective
Execute Milestone 1 only: Chrome attach proof.

## Goal
Prove the Windows-hosted service can attach to real visible Chrome and report healthy state + tabs.

## Files expected to be touched
- `src/index.js`
- `src/api/server.js`
- `src/api/routes/health.js`
- `src/api/routes/tabs.js`
- `src/chrome/launcher.js`
- `src/cdp/session.js`
- `src/state/store.js`

## Acceptance criteria
- service starts locally
- `GET /health` works
- `GET /tabs` works
- Chrome attach/validation path is real and observable
- no drift into fake managed browser logic

## Verification target
At minimum:
- start service
- hit `/health`
- hit `/tabs`
- record result in implementation note

## Stop point
After Milestone 1 works, stop and hand off to separate reviewer.

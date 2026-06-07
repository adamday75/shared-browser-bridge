# shared-browser-bridge

Local shared-control browser bridge for a real visible Chrome session.

## Thesis

People do not actually want a fake automation browser when they are already logged into the real one.
They want agents to use the browser they are already using, keep real session state, stay visible, and allow clean human takeover.

## V1

A Windows-hosted Node service that:
- attaches to real visible Chrome via CDP
- exposes a tiny local API
- supports goto / click / type / snapshot / tabs / url
- preserves real logged-in session state
- supports human interrupt and agent resume

## Why Windows-side browser

For this setup, the browser should live on the **Windows side**.
That is the whole point of the project:
- Chrome is real and visible on the Windows desktop
- login/session state is native and stable
- WSL/OpenClaw/other agents call into a local bridge instead of launching fake side browsers

## Run mode

The intended production setup is the **Node bridge running on Windows**,
attached to the user's real visible Windows Chrome via CDP. WSL (and any
other host) is a *client* lane — it calls the bridge's local HTTP API, it
does not host the controlled browser.

Running the bridge from WSL against a local headless Chrome (as in the
Milestone 1 verification) is a development/testing convenience for
exercising the bridge's attach/launch logic — it is not the real target
setup and should not be mistaken for it.

## First docs

- `docs/BUILD_READY_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/REVIEW_WORKFLOW.md`

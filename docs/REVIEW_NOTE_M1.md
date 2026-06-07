# Review Note — Milestone 1

Reviewer: Gary / OpenClaw
Date: 2026-06-06
Status: REVISE

## Findings

1. The builder stayed inside Milestone 1 scope and kept the API surface small.
2. Localhost-only API behavior is preserved by default.
3. The implementation note is honest about Chrome single-instance behavior and the limits of launch fallback.
4. Real risk found: when `CDP_HOST` points at the Windows host from WSL and attach fails, the current fallback may launch Linux Chrome from WSL (`/usr/bin/google-chrome`), which violates the project's core promise of controlling the real visible Windows Chrome.
5. Additional real-world verification against `http://172.22.96.1:9222/json/version` showed the endpoint was reachable by TCP but returned `connection reset by peer` during this review pass, so the Windows-host attach path is not yet stable enough to call fully done.

## Risks

- Drift into a fake local Linux browser when Windows attach is flaky.
- Ambiguous launch policy: the bridge should not silently launch a different browser host than the one it is supposed to control.
- Milestone 1 verification is strong on local CDP proof, but still incomplete on the intended Windows-host path.

## Requested changes

1. Add a launch policy guard so fallback launch only happens for local host attach (`127.0.0.1` / `localhost`) or only when an explicit env flag allows it.
2. If `CDP_HOST` is non-local and attach fails, return an honest attach error instead of launching a different browser.
3. Document the intended run mode more explicitly: the Node bridge should run on Windows for the real production path; WSL is a client lane.
4. Re-run verification after the launch-policy fix.

## Approval status

REVISE

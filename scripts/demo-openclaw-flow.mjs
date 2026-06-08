#!/usr/bin/env node
/**
 * M4 Build 1 demo: drives the bridge through a minimal end-to-end flow.
 * Requires the bridge to already be running (npm start) with Chrome attached.
 */
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

const adapter = createOpenClawAdapter();
let failed = false;

function log(label, detail) {
  process.stdout.write(`[demo] ${label}: ${detail}\n`);
}

function fail(label, detail) {
  process.stderr.write(`[demo] FAIL ${label}: ${detail}\n`);
  failed = true;
}

async function step(label, fn, { required = true } = {}) {
  try {
    const result = await fn();
    return result;
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (required) fail(label, msg);
    else log(label, `skipped (${msg})`);
    return null;
  }
}

// 1. health
const healthResult = await step('health', async () => {
  const { status, body } = await adapter.health();
  if (status !== 200 || !body?.ok) {
    fail('health', `status=${status} ok=${body?.ok}`);
    return null;
  }
  log('health', 'OK');
  return body;
});

if (!healthResult) {
  process.stderr.write('[demo] bridge not reachable — is it running on http://127.0.0.1:7820?\n');
  process.exit(1);
}

// 2. initial state
let initialState;
await step('state', async () => {
  const { status, body } = await adapter.state();
  if (status !== 200) { fail('state', `status=${status}`); return; }
  initialState = body.controlState;
  log('initial state', initialState);
});

// 3. normalize start state
if (initialState === 'ERROR' || initialState === 'DETACHED') {
  await step('recover', async () => {
    const { status, body } = await adapter.recover();
    if (status !== 200) { fail('recover', `status=${status} error=${body?.error}`); return; }
    log('recover', `OK -> ${body.controlState}`);
  });
} else if (initialState === 'PAUSED') {
  await step('resume (startup)', async () => {
    const { status, body } = await adapter.resume({ force: true });
    if (status !== 200) { fail('resume (startup)', `status=${status} error=${body?.error}`); return; }
    log('resume (startup)', `OK -> ${body.controlState}`);
  });
}

// 4. goto
await step('goto', async () => {
  const { status, body } = await adapter.goto({ url: 'https://example.com' });
  if (status !== 200) { fail('goto', `status=${status} error=${body?.error}`); return; }
  log('goto', `OK -> ${body.url ?? 'https://example.com'}`);
});

// 5. url
await step('url', async () => {
  const { status, body } = await adapter.url();
  if (status !== 200) { fail('url', `status=${status}`); return; }
  log('url', body.url);
});

// 6. pause
let pauseState;
await step('pause', async () => {
  const { status, body } = await adapter.pause({ reason: 'demo' });
  if (status !== 200) { fail('pause', `status=${status} error=${body?.error}`); return; }
  pauseState = body.controlState;
  log('pause', `OK -> ${pauseState}`);
});

// 7. state while paused
await step('state (paused)', async () => {
  const { status, body } = await adapter.state();
  if (status !== 200) { fail('state (paused)', `status=${status}`); return; }
  log('state while paused', body.controlState);
});

// 8. resume
let resumeState;
await step('resume', async () => {
  const { status, body } = await adapter.resume({ force: true });
  if (status !== 200) { fail('resume', `status=${status} error=${body?.error}`); return; }
  resumeState = body.controlState;
  log('resume', `OK -> ${resumeState}`);
});

// 9. final state
await step('final state', async () => {
  const { status, body } = await adapter.state();
  if (status !== 200) { fail('final state', `status=${status}`); return; }
  log('final state', body.controlState);
});

process.exit(failed ? 1 : 0);

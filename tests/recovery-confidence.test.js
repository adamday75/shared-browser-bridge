import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/api/server.js';
import { CdpConnectionError, NoPageTargetError } from '../src/cdp/session.js';

function makeSpyStore(stateOverrides = {}) {
  const state = {
    attached: false,
    chrome: null,
    error: null,
    controlState: 'DETACHED',
    pauseReason: null,
    lastAgentAction: null,
    lastHumanActivity: null,
    lastTakeover: null,
    targetTab: null,
    ...stateOverrides,
  };
  const calls = {};
  const spy = (name) => (...args) => {
    if (!calls[name]) calls[name] = [];
    calls[name].push(args);
  };
  return {
    getState: () => state,
    recordRejectedAction: spy('recordRejectedAction'),
    recordAgentAction: spy('recordAgentAction'),
    transition: spy('transition'),
    recordHumanActivity: spy('recordHumanActivity'),
    recordTargetTab: spy('recordTargetTab'),
    clearTargetTab: spy('clearTargetTab'),
    setAttached: spy('setAttached'),
    setAttachError: spy('setAttachError'),
    setDetached: spy('setDetached'),
    callCount: (name) => (calls[name] ?? []).length,
    firstCallArgs: (name) => (calls[name] ?? [[]])[0],
  };
}

// Store whose getState() returns a different snapshot after the first call,
// simulating a concurrent state change that arrives while async CDP work runs.
function makeShiftingSpyStore(firstState, laterState) {
  let calls = 0;
  const mutatorCalls = {};
  const spy = (name) => (...args) => {
    if (!mutatorCalls[name]) mutatorCalls[name] = [];
    mutatorCalls[name].push(args);
  };
  return {
    getState: () => (++calls === 1 ? firstState : laterState),
    recordRejectedAction: spy('recordRejectedAction'),
    recordAgentAction: spy('recordAgentAction'),
    transition: spy('transition'),
    recordHumanActivity: spy('recordHumanActivity'),
    recordTargetTab: spy('recordTargetTab'),
    clearTargetTab: spy('clearTargetTab'),
    setAttached: spy('setAttached'),
    setAttachError: spy('setAttachError'),
    setDetached: spy('setDetached'),
    callCount: (name) => (mutatorCalls[name] ?? []).length,
  };
}

function startServer(options = {}) {
  const store = options.store ?? makeSpyStore(options.stateOverrides);
  const server = createServer({
    store,
    session: options.session ?? null,
    recoverSession: options.recoverSession ?? null,
    setSession: () => {},
    clearSession: () => {},
    logger: { log: () => {}, error: () => {} },
    apiToken: null,
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, store });
    });
    server.on('error', reject);
  });
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Target disappearance during resume validation window ──────────────────────

test('resume: stored targetTab but no session returns STATE_CONFLICT, stays PAUSED', async (t) => {
  // PAUSED with a recorded baseline but no live session to verify against.
  // The bridge cannot prove the target is still valid and must not resume blindly.
  // Verify: response signals PAUSED and no transition was attempted on the store.
  const store = makeSpyStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Saved Page' },
  });
  const { server, port } = await startServer({ store, session: null });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  // Prove no state transition was attempted — the route returned early without
  // touching the store beyond the guard read.
  assert.equal(store.callCount('transition'), 0, 'transition must not be called when blocking resume');
});

test('resume: adoptCurrentTarget when all tabs disappear returns NO_PAGE_TARGET, state ERROR', async (t) => {
  // Caller issues adoptCurrentTarget but every page tab has closed in the
  // window between the request arriving and the CDP check executing.
  // Verify: response signals ERROR and transition('ERROR') was written to the store.
  const store = makeSpyStore({ controlState: 'PAUSED' });
  const session = {
    getFirstPageTarget: async () => { throw new NoPageTargetError(); },
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptCurrentTarget: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  // Prove the ERROR transition was written — not just that the response body says ERROR.
  assert.equal(store.callCount('transition'), 1, 'transition must be called once to move to ERROR');
  assert.equal(store.firstCallArgs('transition')[0], 'ERROR', 'transition must target ERROR state');
});

// ── Superseded recover: concurrent state change must not silently win ─────────

test('recover: state changes during CDP success returns STATE_CONFLICT, not success', async (t) => {
  // A concurrent action (e.g. explicit detach/attach) moves the store to
  // ATTACHED while recover's async CDP work is in flight. The superseded guard
  // must fire and return STATE_CONFLICT rather than silently overwriting the
  // concurrent state with the stale recovery result.
  // Verify: response signals STATE_CONFLICT and setAttached was suppressed.
  const store = makeShiftingSpyStore(
    { controlState: 'ERROR', attached: false, chrome: null, error: 'prior failure',
      pauseReason: null, lastAgentAction: null, lastHumanActivity: null,
      lastTakeover: null, targetTab: null },
    { controlState: 'ATTACHED', attached: true, chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
      error: null, pauseReason: null, lastAgentAction: null, lastHumanActivity: null,
      lastTakeover: null, targetTab: null },
  );
  const recoverSession = async () => ({
    chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
    session: { getFirstPageTarget: async () => ({ id: 'tab-1', url: 'http://example.com', title: 'Test' }) },
  });
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await post(port, '/control/recover', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  // controlState in the body reflects the concurrent state, not the starting ERROR state
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(res.body.error.includes('superseded'));
  // Prove the stale write was suppressed — setAttached must not have been called.
  assert.equal(store.callCount('setAttached'), 0, 'setAttached must not be called when recovery is superseded');
});

test('recover: state changes during CDP failure returns STATE_CONFLICT, not CDP_ERROR', async (t) => {
  // Same concurrent-change scenario but the CDP work itself also fails.
  // The superseded guard in the catch block must take priority: the response
  // must be STATE_CONFLICT (not 503 CDP_ERROR) so the caller sees the true
  // current state rather than a stale error from work that no longer owns state.
  // Verify: response signals STATE_CONFLICT and setAttachError was suppressed.
  const store = makeShiftingSpyStore(
    { controlState: 'ERROR', attached: false, chrome: null, error: 'prior failure',
      pauseReason: null, lastAgentAction: null, lastHumanActivity: null,
      lastTakeover: null, targetTab: null },
    { controlState: 'ATTACHED', attached: true, chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
      error: null, pauseReason: null, lastAgentAction: null, lastHumanActivity: null,
      lastTakeover: null, targetTab: null },
  );
  const recoverSession = async () => { throw new CdpConnectionError('connection refused'); };
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await post(port, '/control/recover', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(res.body.error.includes('superseded'));
  // Prove the stale error-write was suppressed — setAttachError must not be called
  // when the superseded guard fires before error-handling.
  assert.equal(store.callCount('setAttachError'), 0, 'setAttachError must not be called when recovery is superseded');
});

// ── Recover from DETACHED (not only ERROR) ────────────────────────────────────

test('recover from DETACHED with no page target returns NO_PAGE_TARGET, state ERROR', async (t) => {
  // recover accepts both ERROR and DETACHED as starting states. Verify the
  // NO_PAGE_TARGET path fires correctly when the session has no open tabs
  // and the starting state is DETACHED rather than ERROR.
  // Verify: response signals ERROR and setAttachError was written to the store.
  const store = makeSpyStore({ controlState: 'DETACHED' });
  const recoverSession = async () => ({
    chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
    session: { getFirstPageTarget: async () => { throw new NoPageTargetError(); } },
  });
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await post(port, '/control/recover', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
  // Prove the error was actually written to the store — not just that the response body says ERROR.
  assert.equal(store.callCount('setAttachError'), 1, 'setAttachError must be called to persist the ERROR state');
});

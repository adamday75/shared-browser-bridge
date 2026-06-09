import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/api/server.js';

function makeSpyStore(stateOverrides = {}) {
  const state = {
    attached: false, chrome: null, error: null,
    controlState: 'DETACHED', pauseReason: null,
    lastAgentAction: null, lastHumanActivity: null,
    lastTakeover: null, targetTab: null,
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

function makeStore(stateOverrides = {}) {
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
  return {
    getState: () => state,
    recordRejectedAction: () => {},
    recordAgentAction: () => {},
    transition: () => {},
    recordHumanActivity: () => {},
    recordTargetTab: () => {},
    clearTargetTab: () => {},
    setAttached: () => {},
    setAttachError: () => {},
    setDetached: () => {},
  };
}

function startServer(options = {}) {
  const store = options.store ?? makeStore(options.stateOverrides);
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
      resolve({ server, port: server.address().port });
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

// ── adoptTargetId: explicit target selection ──────────────────────────────────

test('adoptTargetId: valid id resumes and adopts that specific target', async (t) => {
  // Two tabs available. Caller explicitly picks tab-2 by id.
  // Verify: 200, ATTACHED, adoptedTarget reflects tab-2.
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
      { id: 'tab-2', url: 'http://other.com', title: 'Tab Two' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-2' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(res.body.adoptedTarget && typeof res.body.adoptedTarget === 'object');
  assert.equal(res.body.adoptedTarget.id, 'tab-2');
  assert.equal(res.body.adoptedTarget.url, 'http://other.com');
  assert.equal(res.body.adoptedTarget.title, 'Tab Two');
});

test('adoptTargetId: matching id same as current baseline still resumes', async (t) => {
  // Caller explicitly re-adopts the current baseline tab. Valid — explicit is explicit.
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.equal(res.body.adoptedTarget.id, 'tab-1');
});

test('adoptTargetId: unknown id returns TARGET_NOT_FOUND with availableTargets, stays PAUSED', async (t) => {
  // Caller requests a tab id that does not appear in the current open-tab list.
  // Verify: 409 TARGET_NOT_FOUND, availableTargets lists what is actually open,
  // controlState stays PAUSED (no state change).
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
      { id: 'tab-2', url: 'http://other.com', title: 'Tab Two' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-unknown' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'TARGET_NOT_FOUND');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string' && res.body.error.includes('tab-unknown'));
  assert.ok(Array.isArray(res.body.availableTargets), 'availableTargets must be present');
  assert.equal(res.body.availableTargets.length, 2);
  assert.equal(res.body.availableTargets[0].id, 'tab-1');
  assert.equal(res.body.availableTargets[1].id, 'tab-2');
});

test('adoptTargetId: no session returns STATE_CONFLICT, stays PAUSED', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  const { server, port } = await startServer({ store, session: null });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'PAUSED');
});

test('adoptTargetId: all tabs gone returns NO_PAGE_TARGET, state ERROR', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  const session = { listTabs: async () => [] };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-1' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
});

test('adoptTargetId + adoptCurrentTarget returns bad request', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-1', adoptCurrentTarget: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INVALID_INPUT');
  assert.ok(res.body.error.includes('adoptTargetId'));
});

test('adoptTargetId + force returns bad request', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-1', force: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INVALID_INPUT');
  assert.ok(res.body.error.includes('adoptTargetId'));
});

// ── TARGET_DRIFT: availableTargets shows all open tabs ────────────────────────

test('TARGET_DRIFT: availableTargets includes all open tabs (multiple)', async (t) => {
  // Three tabs open. First tab is different from baseline so TARGET_DRIFT fires.
  // Verify: availableTargets lists all three tabs so the caller can choose which
  // one to adopt via adoptTargetId without a separate GET /tabs round-trip.
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://baseline.com', title: 'Baseline' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-2', url: 'http://alpha.com', title: 'Alpha' },
      { id: 'tab-3', url: 'http://beta.com', title: 'Beta' },
      { id: 'tab-4', url: 'http://gamma.com', title: 'Gamma' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TARGET_DRIFT');
  assert.ok(Array.isArray(res.body.availableTargets), 'availableTargets must be an array');
  assert.equal(res.body.availableTargets.length, 3);
  const ids = res.body.availableTargets.map((t) => t.id);
  assert.deepEqual(ids, ['tab-2', 'tab-3', 'tab-4']);
});

// ── adoptTargetId: store writes verified with spy store ───────────────────────

test('adoptTargetId: records correct target to store on success', async (t) => {
  // Prove that the route actually writes the matched target to the store,
  // not just that the response body claims it did. Uses a spy store so we
  // can inspect the exact args passed to recordTargetTab and transition.
  const store = makeSpyStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
      { id: 'tab-2', url: 'http://other.com', title: 'Tab Two' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  await post(port, '/control/resume', { adoptTargetId: 'tab-2' });

  assert.equal(store.callCount('transition'), 1, 'transition must be called once');
  assert.equal(store.firstCallArgs('transition')[0], 'ATTACHED', 'must transition to ATTACHED');
  assert.equal(store.callCount('recordTargetTab'), 1, 'recordTargetTab must be called once');
  const recorded = store.firstCallArgs('recordTargetTab')[0];
  assert.equal(recorded.id, 'tab-2', 'recorded id must match adopted target');
  assert.equal(recorded.url, 'http://other.com', 'recorded url must match adopted target');
  assert.equal(recorded.title, 'Tab Two', 'recorded title must match adopted target');
  assert.equal(store.callCount('recordHumanActivity'), 1, 'recordHumanActivity must be called once');
});

test('adoptTargetId: does not write to store on TARGET_NOT_FOUND', async (t) => {
  // When the requested id is not found, no state must be written.
  // State stays PAUSED and the store is untouched.
  const store = makeSpyStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Tab One' },
  });
  const session = {
    listTabs: async () => [{ id: 'tab-1', url: 'http://example.com', title: 'Tab One' }],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { adoptTargetId: 'tab-unknown' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TARGET_NOT_FOUND');

  assert.equal(store.callCount('transition'), 0, 'transition must not be called on failure');
  assert.equal(store.callCount('recordTargetTab'), 0, 'recordTargetTab must not be called on failure');
});

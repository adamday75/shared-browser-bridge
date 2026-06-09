import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/api/server.js';

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

// ── TARGET_DRIFT: drift object includes title fields ──────────────────────────

test('TARGET_DRIFT: drift object includes expectedTitle and currentTitle', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Example Page' },
  });
  const session = {
    listTabs: async () => [{ id: 'tab-2', url: 'http://other.com', title: 'Other Page' }],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TARGET_DRIFT');
  assert.ok(res.body.drift && typeof res.body.drift === 'object');
  assert.equal(res.body.drift.expectedTabId, 'tab-1');
  assert.equal(res.body.drift.expectedUrl, 'http://example.com');
  assert.equal(res.body.drift.expectedTitle, 'Example Page');
  assert.equal(res.body.drift.currentTabId, 'tab-2');
  assert.equal(res.body.drift.currentUrl, 'http://other.com');
  assert.equal(res.body.drift.currentTitle, 'Other Page');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(Array.isArray(res.body.availableTargets), 'availableTargets must be an array');
  assert.equal(res.body.availableTargets.length, 1);
  assert.equal(res.body.availableTargets[0].id, 'tab-2');
  assert.equal(res.body.availableTargets[0].url, 'http://other.com');
  assert.equal(res.body.availableTargets[0].title, 'Other Page');
});

test('TARGET_DRIFT: url-only drift includes both title fields and availableTargets', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Before' },
  });
  const session = {
    listTabs: async () => [{ id: 'tab-1', url: 'http://example.com/other', title: 'After' }],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TARGET_DRIFT');
  assert.equal(res.body.drift.expectedTitle, 'Before');
  assert.equal(res.body.drift.currentTitle, 'After');
  assert.ok(Array.isArray(res.body.availableTargets));
  assert.equal(res.body.availableTargets[0].id, 'tab-1');
});

test('TARGET_DRIFT: expectedTitle and currentTitle are null when tabs lack a title', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com' }, // no title property
  });
  const session = {
    listTabs: async () => [{ id: 'tab-1', url: 'http://other.com' }], // url changed, no title
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'TARGET_DRIFT');
  assert.equal(res.body.drift.expectedTitle, null);
  assert.equal(res.body.drift.currentTitle, null);
});

// ── MISSING_BASELINE: resume blocked after agent action with no target tab ────

test('MISSING_BASELINE: resume blocked when agent acted but no baseline was recorded', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: null,
    lastAgentAction: { label: 'page:goto', at: new Date().toISOString(), status: 200, ok: true },
  });
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'MISSING_BASELINE');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

test('MISSING_BASELINE: force:true bypasses the missing-baseline block', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: null,
    lastAgentAction: { label: 'page:goto', at: new Date().toISOString(), status: 200, ok: true },
  });
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', { force: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'ATTACHED');
});

test('MISSING_BASELINE: does not fire when agent has no action history (plain paused resume allowed)', async (t) => {
  // Contrast: MISSING_BASELINE only fires when lastAgentAction is set.
  // Paused with no baseline AND no prior agent action is a clean resume — no block.
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: null,
    lastAgentAction: null,
  });
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'ATTACHED');
});

// ── NO_PAGE_TARGET: pre-existing resume-verification path, included for completeness ──────────

test('NO_PAGE_TARGET: resume verification fails when no open tabs remain', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Page' },
  });
  const session = {
    listTabs: async () => [],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await post(port, '/control/resume', {});
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});


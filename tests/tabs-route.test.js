import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/api/server.js';
import { CdpConnectionError } from '../src/cdp/session.js';

function makeStore(stateOverrides = {}) {
  const state = {
    attached: true,
    chrome: { mode: 'attached', endpoint: 'http://127.0.0.1:9222' },
    error: null,
    controlState: 'ATTACHED',
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

function get(port, path) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path, method: 'GET' };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── GET /tabs: basic response shape ──────────────────────────────────────────

test('GET /tabs: returns tabs list with count and baselineTargetId', async (t) => {
  const store = makeStore({
    targetTab: { id: 'tab-2', url: 'http://example.com', title: 'Example' },
  });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://first.com', title: 'First' },
      { id: 'tab-2', url: 'http://example.com', title: 'Example' },
      { id: 'tab-3', url: 'http://third.com', title: 'Third' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.baselineTargetId, 'tab-2', 'baselineTargetId must reflect the stored baseline');
  assert.ok(Array.isArray(res.body.tabs));
  assert.equal(res.body.tabs.length, 3);
  assert.equal(res.body.tabs[0].id, 'tab-1');
  assert.equal(res.body.tabs[1].id, 'tab-2');
  assert.equal(res.body.tabs[2].id, 'tab-3');
});

test('GET /tabs: baselineTargetId is null when no baseline is recorded', async (t) => {
  // Bridge is attached but no target has been recorded yet.
  const store = makeStore({ targetTab: null });
  const session = {
    listTabs: async () => [
      { id: 'tab-1', url: 'http://example.com', title: 'Example' },
    ],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.strictEqual(res.body.baselineTargetId, null, 'baselineTargetId must be null when no baseline exists');
});

test('GET /tabs: returns NOT_ATTACHED when bridge is not attached', async (t) => {
  const store = makeStore({ attached: false, controlState: 'DETACHED' });
  const { server, port } = await startServer({ store, session: null });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NOT_ATTACHED');
});

test('GET /tabs: returns NOT_ATTACHED when session is null', async (t) => {
  // store says attached but no session object — bridge in a bad in-between state.
  const store = makeStore({ attached: true });
  const { server, port } = await startServer({ store, session: null });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NOT_ATTACHED');
});

test('GET /tabs: returns CDP_ERROR when Chrome connection fails', async (t) => {
  const store = makeStore({ attached: true });
  const session = {
    listTabs: async () => { throw new CdpConnectionError('connection refused'); },
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

test('GET /tabs: empty tab list returns count 0 and baselineTargetId null', async (t) => {
  const store = makeStore({ targetTab: null });
  const session = { listTabs: async () => [] };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await get(port, '/tabs');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.count, 0);
  assert.strictEqual(res.body.baselineTargetId, null);
  assert.deepEqual(res.body.tabs, []);
});

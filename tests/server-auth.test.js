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
  const store = makeStore(options.stateOverrides);
  const server = createServer({
    store,
    session: null,
    recoverSession: null,
    setSession: () => {},
    clearSession: () => {},
    logger: { log: () => {}, error: () => {} },
    apiToken: options.apiToken ?? null,
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
    server.on('error', reject);
  });
}

function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path, method, headers };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ── No token configured (default local behavior) ─────────────────────────────

test('GET /health returns 200 with no token configured', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('GET /control/state returns 200 with no token configured', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/control/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'DETACHED');
});

test('unknown route returns 404 with no token configured', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/nonexistent');
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
});

// ── Token configured — rejection cases ───────────────────────────────────────

test('GET /health returns 401 when token required and no auth header sent', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/health');
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.error, 'error message present');
});

test('GET /health returns 401 when wrong token sent', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/health', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('GET /health returns 401 for wrong auth scheme', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/health', {
    headers: { authorization: 'Basic dXNlcjpwYXNz' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('GET /health returns 401 for empty auth header', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/health', {
    headers: { authorization: '' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('unknown route returns 401 (not 404) when token required and no auth', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/nonexistent');
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

// ── Token configured — success cases ─────────────────────────────────────────

test('GET /health returns 200 with correct bearer token', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/health', {
    headers: { authorization: 'Bearer test-secret' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('GET /control/state returns 200 with correct bearer token', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/control/state', {
    headers: { authorization: 'Bearer test-secret' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.controlState, 'DETACHED');
});

// ── Route behavior intact after auth layer ────────────────────────────────────

test('POST /control/pause returns 409 from DETACHED state (no token)', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/control/pause', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /cannot pause from state/);
});

test('POST /control/pause returns 409 from DETACHED state (with valid token)', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/control/pause', {
    method: 'POST',
    headers: { authorization: 'Bearer test-secret' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /cannot pause from state/);
});

test('POST /control/pause returns 401 from DETACHED state (token required, not sent)', async (t) => {
  const { server, port } = await startServer({ apiToken: 'test-secret' });
  t.after(() => server.close());

  const res = await request(port, '/control/pause', { method: 'POST' });
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
});

test('GET /health returns 200 with ATTACHED state and no token', async (t) => {
  const { server, port } = await startServer({
    stateOverrides: {
      attached: true,
      controlState: 'ATTACHED',
      chrome: { mode: 'attach', browser: 'chrome', endpoint: 'ws://127.0.0.1:9222' },
    },
  });
  t.after(() => server.close());

  const res = await request(port, '/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.attached, true);
});

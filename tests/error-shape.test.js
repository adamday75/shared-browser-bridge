import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/api/server.js';
import { CdpConnectionError, NoPageTargetError } from '../src/cdp/session.js';
import { TransitionError } from '../src/state/store.js';

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

// ── Auth failure ──────────────────────────────────────────────────────────────

test('auth failure: 401 with code AUTH_FAILED', async (t) => {
  const { server, port } = await startServer({ apiToken: 'secret' });
  t.after(() => server.close());

  const res = await request(port, '/health');
  assert.equal(res.status, 401);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'AUTH_FAILED');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

test('auth failure: wrong token returns 401 with code AUTH_FAILED', async (t) => {
  const { server, port } = await startServer({ apiToken: 'secret' });
  t.after(() => server.close());

  const res = await request(port, '/health', { headers: { authorization: 'Bearer wrong' } });
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'AUTH_FAILED');
});

// ── Unknown route ─────────────────────────────────────────────────────────────

test('unknown route: 404 with code NOT_FOUND', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/nonexistent');
  assert.equal(res.status, 404);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NOT_FOUND');
  assert.ok(typeof res.body.error === 'string');
});

// ── Invalid input ─────────────────────────────────────────────────────────────

test('invalid input: missing url field returns 400 with code INVALID_INPUT', async (t) => {
  // Need non-DETACHED + non-null session so the guard passes input validation first
  const { server, port } = await startServer({
    session: {},
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INVALID_INPUT');
});

test('invalid input: malformed JSON body returns 400 with code INVALID_INPUT', async (t) => {
  const { server, port } = await startServer({
    session: {},
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-valid-json',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INVALID_INPUT');
});

// ── Paused-state rejection ────────────────────────────────────────────────────

test('paused state: page action rejected with code PAUSED and controlState', async (t) => {
  const { server, port } = await startServer({
    session: {},
    stateOverrides: { controlState: 'PAUSED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'PAUSED');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string');
});

// ── Detached / not-ready rejection ────────────────────────────────────────────

test('detached: page action rejected with code NOT_ATTACHED and controlState', async (t) => {
  // Default: session=null, controlState=DETACHED
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NOT_ATTACHED');
  assert.equal(res.body.controlState, 'DETACHED');
});

// ── Internal error ────────────────────────────────────────────────────────────

test('internal error: unexpected handler throw returns 500 with code INTERNAL_ERROR', async (t) => {
  const brokenStore = {
    getState: () => { throw new Error('simulated internal failure'); },
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
  const { server, port } = await startServer({ store: brokenStore });
  t.after(() => server.close());

  const res = await request(port, '/health');
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'INTERNAL_ERROR');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

// ── PageActionError path ──────────────────────────────────────────────────────

test('page action error: PageActionError returns code PAGE_ACTION_ERROR', async (t) => {
  // Session returns a target without a debugger URL, which causes withPage to
  // throw PageActionError before any CDP websocket is opened.
  const session = {
    getFirstPageTarget: async () => ({
      id: 'tab-1', url: 'http://example.com', title: 'Test',
      webSocketDebuggerUrl: null,
    }),
  };
  const { server, port } = await startServer({
    session,
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'PAGE_ACTION_ERROR');
  assert.ok(typeof res.body.error === 'string');
});

// ── CDP error paths in handoff guard ─────────────────────────────────────────

test('CDP connection error during page action returns 503 with code CDP_ERROR', async (t) => {
  const session = {
    getFirstPageTarget: async () => { throw new CdpConnectionError('connection lost'); },
  };
  const { server, port } = await startServer({
    session,
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.ok(typeof res.body.error === 'string');
});

test('no page target during page action returns 409 with code NO_PAGE_TARGET and controlState ERROR', async (t) => {
  const session = {
    getFirstPageTarget: async () => { throw new NoPageTargetError(); },
  };
  const { server, port } = await startServer({
    session,
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com' }),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
});

// ── TransitionError paths in control routes ───────────────────────────────────

test('pause: concurrent TransitionError returns 409 with code STATE_CONFLICT', async (t) => {
  const store = makeStore({ controlState: 'ATTACHED' });
  store.transition = () => { throw new TransitionError('cannot transition from ATTACHED to PAUSED'); };
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  const res = await request(port, '/control/pause', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.ok(typeof res.body.error === 'string');
});

test('resume: concurrent TransitionError returns 409 with code STATE_CONFLICT', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  store.transition = () => { throw new TransitionError('cannot transition from PAUSED to ATTACHED'); };
  const { server, port } = await startServer({ store });
  t.after(() => server.close());

  // force:true skips all session/target checks so only store.transition can fail
  const res = await request(port, '/control/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.ok(typeof res.body.error === 'string');
});

// ── State-guard branches in control routes ────────────────────────────────────

test('pause: already paused returns 409 with code STATE_CONFLICT', async (t) => {
  const { server, port } = await startServer({ stateOverrides: { controlState: 'PAUSED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/pause', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string');
});

test('pause: non-pauseable state returns 409 with code STATE_CONFLICT', async (t) => {
  const { server, port } = await startServer({ stateOverrides: { controlState: 'DETACHED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/pause', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'DETACHED');
  assert.ok(typeof res.body.error === 'string');
});

test('resume: non-paused state returns 409 with code STATE_CONFLICT', async (t) => {
  const { server, port } = await startServer({ stateOverrides: { controlState: 'ATTACHED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/resume', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(typeof res.body.error === 'string');
});

test('resume: target drift returns 409 with code TARGET_DRIFT and drift field', async (t) => {
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Original' },
  });
  const session = {
    listTabs: async () => [{ id: 'tab-2', url: 'http://other.com', title: 'Changed' }],
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await request(port, '/control/resume', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'TARGET_DRIFT');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(res.body.drift && typeof res.body.drift === 'object');
  assert.equal(res.body.drift.expectedTabId, 'tab-1');
  assert.equal(res.body.drift.currentTabId, 'tab-2');
  assert.ok(typeof res.body.error === 'string');
});

test('recover: wrong state returns 409 with code STATE_CONFLICT', async (t) => {
  const { server, port } = await startServer({ stateOverrides: { controlState: 'ATTACHED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/recover', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(typeof res.body.error === 'string');
});

test('detach: already detached returns 409 with code STATE_CONFLICT', async (t) => {
  // Default store starts DETACHED
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/control/detach', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'DETACHED');
  assert.ok(typeof res.body.error === 'string');
});

test('detach: non-ERROR state returns 409 with code STATE_CONFLICT', async (t) => {
  const { server, port } = await startServer({ stateOverrides: { controlState: 'ATTACHED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/detach', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'ATTACHED');
  assert.ok(typeof res.body.error === 'string');
});

// ── recover error paths ───────────────────────────────────────────────────────

test('recover: no page target returns 409 with code NO_PAGE_TARGET', async (t) => {
  const store = makeStore({ controlState: 'ERROR' });
  const recoverSession = async () => ({
    chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
    session: { getFirstPageTarget: async () => { throw new NoPageTargetError(); } },
  });
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await request(port, '/control/recover', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});

test('recover: CDP connection error returns 503 with code CDP_ERROR', async (t) => {
  const store = makeStore({ controlState: 'ERROR' });
  const recoverSession = async () => { throw new CdpConnectionError('connection refused'); };
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await request(port, '/control/recover', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});

test('recover: TransitionError during setAttached returns 409 with code STATE_CONFLICT', async (t) => {
  const store = makeStore({ controlState: 'ERROR' });
  store.setAttached = () => { throw new TransitionError('concurrent state change'); };
  const recoverSession = async () => ({
    chrome: { mode: 'attach', endpoint: 'http://localhost:9222' },
    session: { getFirstPageTarget: async () => ({ id: 'tab-1', url: 'http://example.com', title: 'Test' }) },
  });
  const { server, port } = await startServer({ store, recoverSession });
  t.after(() => server.close());

  const res = await request(port, '/control/recover', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});

// ── resume adopt / verification-conflict branches ─────────────────────────────

test('resume: adoptCurrentTarget with no session returns 409 with code STATE_CONFLICT', async (t) => {
  // session=null (default): adopt path cannot proceed without a live session
  const { server, port } = await startServer({ stateOverrides: { controlState: 'PAUSED' } });
  t.after(() => server.close());

  const res = await request(port, '/control/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adoptCurrentTarget: true }),
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'STATE_CONFLICT');
  assert.equal(res.body.controlState, 'PAUSED');
  assert.ok(typeof res.body.error === 'string');
});

test('resume: adoptCurrentTarget CDP error returns 503 with code CDP_ERROR', async (t) => {
  const store = makeStore({ controlState: 'PAUSED' });
  const session = {
    getFirstPageTarget: async () => { throw new CdpConnectionError('lost during adopt'); },
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await request(port, '/control/resume', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adoptCurrentTarget: true }),
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});

// ── /tabs error paths ─────────────────────────────────────────────────────────

test('/tabs not attached: returns 503 with code NOT_ATTACHED', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());

  const res = await request(port, '/tabs');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NOT_ATTACHED');
  assert.ok(typeof res.body.error === 'string' && res.body.error.length > 0);
});

test('/tabs CDP connection error: returns 503 with code CDP_ERROR', async (t) => {
  const session = {
    listTabs: async () => { throw new CdpConnectionError('connection lost'); },
  };
  const { server, port } = await startServer({
    session,
    stateOverrides: { attached: true, controlState: 'ATTACHED' },
  });
  t.after(() => server.close());

  const res = await request(port, '/tabs');
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.ok(typeof res.body.error === 'string');
});

// ── BODY_TOO_LARGE path ───────────────────────────────────────────────────────

test('oversized body: returns 413 with code BODY_TOO_LARGE', async (t) => {
  const { server, port } = await startServer({
    session: {},
    stateOverrides: { controlState: 'ATTACHED', attached: true },
  });
  t.after(() => server.close());

  const res = await request(port, '/page/goto', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.alloc(1024 * 1024 + 1, 'x'),
  });
  assert.equal(res.status, 413);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'BODY_TOO_LARGE');
  assert.ok(typeof res.body.error === 'string');
});

test('resume: CDP error during target verification returns 503 with code CDP_ERROR', async (t) => {
  // PAUSED with a stored targetTab forces the verification path; CDP fails mid-check
  const store = makeStore({
    controlState: 'PAUSED',
    targetTab: { id: 'tab-1', url: 'http://example.com', title: 'Original' },
  });
  const session = {
    listTabs: async () => { throw new CdpConnectionError('lost during verify'); },
  };
  const { server, port } = await startServer({ store, session });
  t.after(() => server.close());

  const res = await request(port, '/control/resume', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'CDP_ERROR');
  assert.equal(res.body.controlState, 'ERROR');
  assert.ok(typeof res.body.error === 'string');
});

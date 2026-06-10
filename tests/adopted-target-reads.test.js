/**
 * M13 regression tests — adopted-target binding for page reads.
 *
 * These tests prove that url(), text(), and snapshot() operate on the
 * explicitly adopted target (store.targetTab.id) rather than the first
 * CDP-listed target when an adoption has been recorded.
 *
 * Two-tab scenario: tab-1 is first in the CDP list, tab-2 was adopted.
 * Before M13 all reads returned tab-1 data. After M13 they return tab-2 data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createServer } from '../src/api/server.js';

// ── shared test infrastructure ────────────────────────────────────────────────

function makeStore(stateOverrides = {}) {
  const state = {
    attached: true,
    chrome: null,
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

function startServer(store, session) {
  const server = createServer({
    store,
    session,
    recoverSession: null,
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
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Starts a minimal CDP-over-WebSocket mock server.
 * responseMap maps CDP method names to the `result` value to return.
 * Any method not in the map gets `{}` as its result.
 */
function startMockCdpServer(responseMap = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.once('listening', () => {
      resolve({
        wss,
        port: wss.address().port,
        close: () => new Promise((res, rej) => wss.close((err) => (err ? rej(err) : res()))),
      });
    });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        const override = responseMap[msg.method];
        const result = override !== undefined ? override : {};
        socket.send(JSON.stringify({ id: msg.id, result }));
      });
    });
  });
}

// ── url() binding ─────────────────────────────────────────────────────────────

test('url() returns adopted tab URL when targetTab is set', async (t) => {
  // tab-1 is first in the CDP list; tab-2 was explicitly adopted.
  // Before M13: url() called getFirstPageTarget() → returned tab-1.
  // After M13:  url() calls getTargetById('tab-2') → returns tab-2.
  const store = makeStore({
    targetTab: { id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two' },
  });

  let getFirstPageTargetCalled = false;
  const session = {
    getTargetById: async (id) => {
      assert.equal(id, 'tab-2');
      return { id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two' };
    },
    getFirstPageTarget: async () => {
      getFirstPageTargetCalled = true;
      return { id: 'tab-1', url: 'http://tab1.example.com', title: 'Tab One' };
    },
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/url');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.url, 'http://tab2.example.com', 'url() must return the adopted tab URL');
  assert.equal(getFirstPageTargetCalled, false, 'getFirstPageTarget must not be called when adoption is recorded');
});

test('url() falls back to first-target when no adoption has been recorded', async (t) => {
  const store = makeStore({ targetTab: null });

  let getTargetByIdCalled = false;
  const session = {
    getTargetById: async () => { getTargetByIdCalled = true; },
    getFirstPageTarget: async () => ({
      id: 'tab-1', url: 'http://tab1.example.com', title: 'Tab One',
    }),
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/url');
  assert.equal(res.status, 200);
  assert.equal(res.body.url, 'http://tab1.example.com', 'url() must return first-target URL when no adoption');
  assert.equal(getTargetByIdCalled, false, 'getTargetById must not be called when no adoption is recorded');
});

// ── text() binding ────────────────────────────────────────────────────────────

test('text() reads from adopted tab when targetTab is set', async (t) => {
  // Two mock CDP WebSocket servers: one per tab, each returning distinct text.
  // The test verifies that text() connects to tab-2's server, not tab-1's.
  const tab1Server = await startMockCdpServer({
    'Runtime.evaluate': { result: { value: 'text-from-tab-1' } },
  });
  const tab2Server = await startMockCdpServer({
    'Runtime.evaluate': { result: { value: 'text-from-tab-2' } },
  });
  t.after(async () => {
    await tab1Server.close();
    await tab2Server.close();
  });

  const store = makeStore({
    targetTab: { id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two' },
  });

  const session = {
    getTargetById: async (id) => {
      if (id === 'tab-2') {
        return {
          id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two',
          webSocketDebuggerUrl: `ws://127.0.0.1:${tab2Server.port}`,
        };
      }
      throw new Error(`unexpected getTargetById call with id: ${id}`);
    },
    getFirstPageTarget: async () => ({
      id: 'tab-1', url: 'http://tab1.example.com', title: 'Tab One',
      webSocketDebuggerUrl: `ws://127.0.0.1:${tab1Server.port}`,
    }),
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/text');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.text, 'text-from-tab-2', 'text() must read from the adopted tab, not the first-listed tab');
});

test('text() falls back to first target when no adoption has been recorded', async (t) => {
  const tab1Server = await startMockCdpServer({
    'Runtime.evaluate': { result: { value: 'text-from-tab-1' } },
  });
  t.after(() => tab1Server.close());

  const store = makeStore({ targetTab: null });

  const session = {
    getFirstPageTarget: async () => ({
      id: 'tab-1', url: 'http://tab1.example.com', title: 'Tab One',
      webSocketDebuggerUrl: `ws://127.0.0.1:${tab1Server.port}`,
    }),
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/text');
  assert.equal(res.status, 200);
  assert.equal(res.body.text, 'text-from-tab-1');
});

// ── snapshot() binding ────────────────────────────────────────────────────────

test('snapshot() reads from adopted tab when targetTab is set', async (t) => {
  const tab1Server = await startMockCdpServer({
    'Runtime.evaluate': { result: { value: [{ tag: 'h1', text: 'Tab One Heading', id: null }] } },
  });
  const tab2Server = await startMockCdpServer({
    'Runtime.evaluate': { result: { value: [{ tag: 'h1', text: 'Tab Two Heading', id: null }] } },
  });
  t.after(async () => {
    await tab1Server.close();
    await tab2Server.close();
  });

  const store = makeStore({
    targetTab: { id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two' },
  });

  const session = {
    getTargetById: async (id) => {
      if (id === 'tab-2') {
        return {
          id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two',
          webSocketDebuggerUrl: `ws://127.0.0.1:${tab2Server.port}`,
        };
      }
      throw new Error(`unexpected getTargetById call with id: ${id}`);
    },
    getFirstPageTarget: async () => ({
      id: 'tab-1', url: 'http://tab1.example.com', title: 'Tab One',
      webSocketDebuggerUrl: `ws://127.0.0.1:${tab1Server.port}`,
    }),
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/snapshot');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(Array.isArray(res.body.snapshot), 'snapshot must be an array');
  assert.equal(res.body.snapshot[0]?.text, 'Tab Two Heading', 'snapshot() must read from the adopted tab, not the first-listed tab');
});

// ── adopted-target id disappears between adoption and read ────────────────────

test('text() returns NO_PAGE_TARGET when adopted tab no longer exists', async (t) => {
  // The adopted tab-2 is gone. getTargetById throws NoPageTargetError.
  // The guard must catch this and return 409 NO_PAGE_TARGET.
  const { NoPageTargetError } = await import('../src/cdp/session.js');

  const store = makeStore({
    targetTab: { id: 'tab-2', url: 'http://tab2.example.com', title: 'Tab Two' },
  });

  const session = {
    getTargetById: async () => { throw new NoPageTargetError(); },
    getFirstPageTarget: async () => { throw new Error('should not be called'); },
  };

  const { server, port } = await startServer(store, session);
  t.after(() => server.close());

  const res = await get(port, '/page/text');
  assert.equal(res.status, 409);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'NO_PAGE_TARGET');
});

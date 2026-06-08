import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

function createJsonResponse(status, body) {
  return {
    status,
    async json() {
      return body;
    },
  };
}

test('adapter methods call expected endpoints and preserve status/body', async () => {
  const calls = [];
  const adapter = createOpenClawAdapter({
    baseUrl: 'http://bridge.local',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return createJsonResponse(200, { ok: true, url });
    },
    timeoutMs: 1234,
  });

  assert.deepEqual(await adapter.health(), {
    status: 200,
    body: { ok: true, url: 'http://bridge.local/health' },
  });
  assert.deepEqual(await adapter.tabs(), {
    status: 200,
    body: { ok: true, url: 'http://bridge.local/tabs' },
  });
  assert.deepEqual(await adapter.url(), {
    status: 200,
    body: { ok: true, url: 'http://bridge.local/page/url' },
  });
  assert.deepEqual(await adapter.state(), {
    status: 200,
    body: { ok: true, url: 'http://bridge.local/control/state' },
  });
  assert.deepEqual(await adapter.recover(), {
    status: 200,
    body: { ok: true, url: 'http://bridge.local/control/recover' },
  });

  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.signal.aborted, false);
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(calls[3].init.method, 'GET');
  assert.equal(calls[4].init.method, 'POST');
  assert.match(calls[0].url, /\/health$/);
  assert.match(calls[1].url, /\/tabs$/);
  assert.match(calls[2].url, /\/page\/url$/);
  assert.match(calls[3].url, /\/control\/state$/);
  assert.match(calls[4].url, /\/control\/recover$/);
});

test('goto validates url locally before network call', async () => {
  let called = false;
  const adapter = createOpenClawAdapter({
    fetchImpl: async () => {
      called = true;
      return createJsonResponse(200, { ok: true });
    },
  });

  await assert.rejects(() => adapter.goto({ url: '' }), {
    name: 'TypeError',
    message: 'goto requires a non-empty url string',
  });
  assert.equal(called, false);
});

test('pause and resume only send supplied fields', async () => {
  const calls = [];
  const adapter = createOpenClawAdapter({
    fetchImpl: async (_url, init) => {
      calls.push(init);
      return createJsonResponse(200, { ok: true });
    },
  });

  await adapter.pause();
  await adapter.pause({ reason: 'demo' });
  await adapter.resume();
  await adapter.resume({ force: true });
  await adapter.resume({ adoptCurrentTarget: true });
  await adapter.resume({ force: true, adoptCurrentTarget: true });

  assert.equal(calls[0].body, JSON.stringify({}));
  assert.equal(calls[1].body, JSON.stringify({ reason: 'demo' }));
  assert.equal(calls[2].body, JSON.stringify({}));
  assert.equal(calls[3].body, JSON.stringify({ force: true }));
  assert.equal(calls[4].body, JSON.stringify({ adoptCurrentTarget: true }));
  assert.equal(calls[5].body, JSON.stringify({ force: true, adoptCurrentTarget: true }));
});

test('transport errors propagate to caller', async () => {
  const adapter = createOpenClawAdapter({
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  await assert.rejects(() => adapter.health(), /network down/);
});

test('non-json responses return null body with status preserved', async () => {
  const adapter = createOpenClawAdapter({
    fetchImpl: async () => ({
      status: 503,
      async json() {
        throw new Error('invalid json');
      },
    }),
  });

  const result = await adapter.health();
  assert.deepEqual(result, { status: 503, body: null });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { withPage } from '../src/cdp/page.js';

test('withPage falls back to ws package when globalThis.WebSocket is unavailable', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const { port } = wss.address();

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      socket.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
    });
  });

  globalThis.WebSocket = undefined;
  try {
    const result = await withPage(
      {
        async getFirstPageTarget() {
          return { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/test` };
        },
      },
      async (client) => client.send('Runtime.enable')
    );
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.WebSocket = originalWebSocket;
    await new Promise((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
  }
});

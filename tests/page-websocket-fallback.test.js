import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { withPage, scoreLocalAnchorText } from '../src/cdp/page.js';

test('scoreLocalAnchorText prefers author/byline blocks over long comment mentions', () => {
  const anchor = 'Ani Filipova';
  const authorByline = 'Ani Filipova\nAuthor\nI help professionals build career options';
  const controlMenu = 'Open control menu for post by Ani Filipova';
  const mistakenComment = 'Under 40 lists measure speed. Calloused hands measure cost. The second group knows something the first one has not lost enough yet to understand Ani Filipova';

  assert.ok(scoreLocalAnchorText(anchor, controlMenu) > scoreLocalAnchorText(anchor, mistakenComment));
  assert.ok(scoreLocalAnchorText(anchor, authorByline) > scoreLocalAnchorText(anchor, mistakenComment));
});

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

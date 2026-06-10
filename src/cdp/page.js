import { WebSocket as WsWebSocket } from 'ws';
import { CdpConnectionError } from './session.js';

/**
 * Real CDP page actions over the DevTools websocket. Milestone 1 only used
 * the CDP HTTP /json/* surface; page actions need the live protocol (Page,
 * DOM, Input, Runtime domains) on a specific page target's debugger
 * websocket. Each call opens a short-lived connection, performs its action,
 * and closes — boring and stateless, no long-lived session to keep healthy.
 */

const CONNECT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const SNAPSHOT_LIMIT = 200;

export class PageActionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'PageActionError';
    this.status = status;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PageActionError(message, 504)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Opens a CDP websocket connection to a single page target and returns a
 * thin client: `send(method, params)` for command/response round trips and
 * `on(listener)` for protocol events (e.g. waiting on Page.loadEventFired).
 */
function connectToTarget(webSocketDebuggerUrl, WebSocketImpl) {
  let ws;
  const connection = new Promise((resolve, reject) => {
    ws = new WebSocketImpl(webSocketDebuggerUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    let opened = false;

    function rejectPending(err) {
      for (const { reject: rejectCmd } of pending.values()) rejectCmd(err);
      pending.clear();
    }

    ws.addEventListener(
      'error',
      () => {
        const err = new CdpConnectionError('CDP websocket connection failed');
        rejectPending(err);
        ws.close();
        if (!opened) reject(err);
      },
      { once: true }
    );

    ws.addEventListener('close', () => {
      rejectPending(new CdpConnectionError('CDP websocket closed'));
    });

    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: resolveCmd, reject: rejectCmd } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rejectCmd(new PageActionError(message.error.message, 502));
        else resolveCmd(message.result);
      } else if (message.method) {
        for (const listener of listeners) listener(message.method, message.params);
      }
    });

    ws.addEventListener(
      'open',
      () => {
        opened = true;
        resolve({
          send(method, params = {}) {
            const id = nextId++;
            const sent = new Promise((res, rej) => {
              pending.set(id, { resolve: res, reject: rej });
              try {
                ws.send(JSON.stringify({ id, method, params }));
              } catch (err) {
                pending.delete(id);
                rej(new CdpConnectionError(`CDP websocket send failed: ${err.message}`));
              }
            });
            return withTimeout(sent, COMMAND_TIMEOUT_MS, `CDP command "${method}" timed out`).catch(
              (err) => {
                pending.delete(id);
                throw err;
              }
            );
          },
          on(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close() {
            ws.close();
          },
        });
      },
      { once: true }
    );
  });
  return withTimeout(connection, CONNECT_TIMEOUT_MS, 'CDP websocket connect timed out').catch((err) => {
    ws?.close();
    if (err instanceof PageActionError && err.message === 'CDP websocket connect timed out') {
      throw new CdpConnectionError(err.message);
    }
    throw err;
  });
}

function waitForEvent(client, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new PageActionError(`timed out waiting for ${method}`, 504));
    }, timeoutMs);
    const unsubscribe = client.on((eventMethod, params) => {
      if (eventMethod === method) {
        clearTimeout(timer);
        unsubscribe();
        resolve(params);
      }
    });
  });
}

export async function gotoUrl(client, url) {
  await client.send('Page.enable');
  const loadEvent = waitForEvent(client, 'Page.loadEventFired', NAVIGATION_TIMEOUT_MS);
  const { errorText } = await client.send('Page.navigate', { url });
  if (errorText) {
    throw new PageActionError(`navigation to "${url}" failed: ${errorText}`, 502);
  }
  await loadEvent;
}

async function findNode(client, selector) {
  await client.send('DOM.enable');
  const { root } = await client.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) {
    throw new PageActionError(`no element matched selector "${selector}"`, 404);
  }
  return nodeId;
}

export async function clickSelector(client, selector) {
  const nodeId = await findNode(client, selector);
  await client.send('DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
  const { model } = await client.send('DOM.getBoxModel', { nodeId });
  const [x0, y0, , , x1, y1] = model.content;
  const x = (x0 + x1) / 2;
  const y = (y0 + y1) / 2;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

export async function typeIntoSelector(client, selector, text) {
  const nodeId = await findNode(client, selector);
  await client.send('DOM.focus', { nodeId });
  await client.send('Input.insertText', { text });
}

export async function getPageText(client) {
  await client.send('Runtime.enable');
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: 'document.body ? document.body.innerText : ""',
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new PageActionError(`could not read page text: ${exceptionDetails.text}`, 502);
  }
  return result.value;
}

// Fixed, read-only expression — not an arbitrary-execution endpoint. It only
// collects a bounded list of interactive/heading elements with their visible
// label and id, which is enough for an agent to choose a selector to act on.
const SNAPSHOT_EXPRESSION = `(() => {
  const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], h1, h2, h3';
  return Array.from(document.querySelectorAll(selectors)).slice(0, ${SNAPSHOT_LIMIT}).map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 120),
    id: el.id || null,
  }));
})()`;

export async function getPageSnapshot(client) {
  await client.send('Runtime.enable');
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: SNAPSHOT_EXPRESSION,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new PageActionError(`could not build page snapshot: ${exceptionDetails.text}`, 502);
  }
  return result.value;
}

/**
 * Connects to the current page target, runs `action`, and always closes the
 * websocket afterwards — short-lived per-request connections instead of a
 * long-lived session that could go stale across navigations or tab changes.
 */
export async function withPage(session, action, { WebSocketImpl = globalThis.WebSocket ?? WsWebSocket, targetId = null } = {}) {
  if (!WebSocketImpl) {
    throw new CdpConnectionError(`CDP websocket unavailable in bridge runtime (typeof globalThis.WebSocket=${typeof globalThis.WebSocket})`);
  }
  const target = (targetId != null)
    ? await session.getTargetById(targetId)
    : await session.getFirstPageTarget();
  if (!target.webSocketDebuggerUrl) {
    throw new PageActionError('active page target has no debugger websocket URL', 502);
  }
  const client = await connectToTarget(target.webSocketDebuggerUrl, WebSocketImpl);
  try {
    return await action(client, target);
  } finally {
    client.close();
  }
}

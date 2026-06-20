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
const SNAPSHOT_LIMIT = 300;

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

// Fixed, read-only expression — not an arbitrary-execution endpoint. It collects
// interactive/heading elements (for agent action selection) PLUS prose-bearing
// elements (for content extraction), merged in DOM order and bounded.
//
// Prose elements (p, article, section, div, span) are filtered to those with
// visible text ≥ 20 chars to avoid massive noise from empty/short containers.
const SNAPSHOT_EXPRESSION = `(() => {
  const LIMIT = ${SNAPSHOT_LIMIT};
  const PROSE_MIN_LEN = 20;

  const interactiveSel = 'a, button, input, textarea, select, [role="button"], [role="link"], h1, h2, h3';
  const proseSel = 'p, article, section, div, span';

  const interactive = new Set(document.querySelectorAll(interactiveSel));
  const prose = document.querySelectorAll(proseSel);

  const collected = new Set();
  for (const el of interactive) collected.add(el);
  for (const el of prose) {
    const t = (el.innerText || '').trim();
    if (t.length >= PROSE_MIN_LEN) collected.add(el);
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => collected.has(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const ordered = [];
  while (walker.nextNode() && ordered.length < LIMIT) {
    const el = walker.currentNode;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 200);
    if (!text) continue;
    ordered.push({
      tag: el.tagName.toLowerCase(),
      text,
      id: el.id || null,
    });
  }
  return ordered;
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
 * Local/anchor-centered snapshot: captures a bounded DOM subtree around an
 * element whose text contains `anchorText`. Instead of walking the entire
 * document.body (which may exhaust the element limit before reaching the
 * target post), this finds the anchor element, walks up to a container
 * ancestor, and captures interactive + prose elements only within that
 * subtree.
 *
 * Returns the same { tag, text, id } element array format as getPageSnapshot,
 * but scoped to the local region. Returns an empty array if no anchor match.
 */
const LOCAL_SNAPSHOT_LIMIT = 120;

export function scoreLocalAnchorText(anchorText, rawText) {
  if (!anchorText || !rawText) return Number.NEGATIVE_INFINITY;
  const anchor = String(anchorText).trim().toLowerCase();
  const text = String(rawText).trim();
  const lower = text.toLowerCase();
  if (!anchor || !lower.includes(anchor)) return Number.NEGATIVE_INFINITY;

  let score = 0;
  const pos = lower.indexOf(anchor);
  const anchorNearEnd = pos >= 0 && pos > lower.length * 0.6;

  const lines = lower.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lower === anchor) score += 500;
  if (lower.startsWith(anchor)) score += 220;
  if (lines.some((line) => line === anchor)) score += 180;
  if (lower.includes(`open control menu for post by ${anchor}`)) score += 420;
  if (lower.includes(`hide post by ${anchor}`)) score += 320;
  if (lower.includes(`post by ${anchor}`)) score += 220;
  if (lower.includes(`view ${anchor}`) && lower.includes('profile')) score += 80;

  if (text.length <= 80) score += 120;
  else if (text.length <= 180) score += 40;
  else if (text.length > 260) score -= 80;

  if (anchorNearEnd) score -= 160;
  if (/\b(reply|replies|comment|commented|reacted)\b/i.test(text) && !lower.startsWith(anchor)) score -= 140;
  if (/\b1w\b|\b1 week ago\b|\b2nd\b|\b3rd\+?\b/i.test(text) && lower.startsWith(anchor)) score += 40;

  return score;
}

function buildLocalSnapshotExpression(anchorText) {
  // Escape for safe embedding in a JS string literal inside the expression
  const escaped = anchorText.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `(() => {
  const LOCAL_LIMIT = ${LOCAL_SNAPSHOT_LIMIT};
  const PROSE_MIN_LEN = 20;
  const ANCHOR_TEXT = '${escaped}'.toLowerCase();

  // Phase 1: find the DOM element whose text best matches the anchor string.
  // Prefer exact/byline/control-menu matches over long prose that only mentions
  // the author name at the end (common in comments quoting the post author).
  function scoreAnchorMatch(rawText) {
    if (!rawText) return Number.NEGATIVE_INFINITY;
    const text = String(rawText).trim();
    const lower = text.toLowerCase();
    if (!lower.includes(ANCHOR_TEXT)) return Number.NEGATIVE_INFINITY;

    let score = 0;
    const pos = lower.indexOf(ANCHOR_TEXT);
    const anchorNearEnd = pos >= 0 && pos > lower.length * 0.6;

    const lines = lower.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    if (lower === ANCHOR_TEXT) score += 500;
    if (lower.startsWith(ANCHOR_TEXT)) score += 220;
    if (lines.some((line) => line === ANCHOR_TEXT)) score += 180;
    if (lower.includes('open control menu for post by ' + ANCHOR_TEXT)) score += 420;
    if (lower.includes('hide post by ' + ANCHOR_TEXT)) score += 320;
    if (lower.includes('post by ' + ANCHOR_TEXT)) score += 220;
    if (lower.includes('view ' + ANCHOR_TEXT) && lower.includes('profile')) score += 80;

    if (text.length <= 80) score += 120;
    else if (text.length <= 180) score += 40;
    else if (text.length > 260) score -= 80;

    if (anchorNearEnd) score -= 160;
    if (/\b(reply|replies|comment|commented|reacted)\b/i.test(text) && !lower.startsWith(ANCHOR_TEXT)) score -= 140;
    if (/\b1w\b|\b1 week ago\b|\b2nd\b|\b3rd\+?\b/i.test(text) && lower.startsWith(ANCHOR_TEXT)) score += 40;

    return score;
  }

  const allEls = document.querySelectorAll('*');
  let anchor = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const el of allEls) {
    const ownText = (el.innerText || el.textContent || '').trim();
    if (!(ownText.length > 0 && ownText.length < 500)) continue;
    const score = scoreAnchorMatch(ownText);
    if (score > bestScore) {
      bestScore = score;
      anchor = el;
    }
  }
  if (!anchor) return [];

  // Phase 2: walk up to a reasonable container ancestor
  const containerTags = new Set(['ARTICLE', 'SECTION', 'MAIN']);
  let container = anchor;
  let walks = 0;
  while (container.parentElement && container.parentElement !== document.body && walks < 8) {
    container = container.parentElement;
    walks++;
    if (containerTags.has(container.tagName)) break;
    if (container.getAttribute && container.getAttribute('role') === 'main') break;
    // A container with many children likely wraps the post region
    if (container.children.length >= 10) break;
  }

  // Phase 3: collect interactive + prose elements within the container subtree
  const interactiveSel = 'a, button, input, textarea, select, [role="button"], [role="link"], h1, h2, h3';
  const proseSel = 'p, article, section, div, span';

  const interactive = new Set(container.querySelectorAll(interactiveSel));
  const prose = container.querySelectorAll(proseSel);

  const collected = new Set();
  for (const el of interactive) collected.add(el);
  for (const el of prose) {
    const t = (el.innerText || '').trim();
    if (t.length >= PROSE_MIN_LEN) collected.add(el);
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => collected.has(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const ordered = [];
  while (walker.nextNode() && ordered.length < LOCAL_LIMIT) {
    const el = walker.currentNode;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 200);
    if (!text) continue;
    ordered.push({
      tag: el.tagName.toLowerCase(),
      text,
      id: el.id || null,
    });
  }
  return ordered;
})()`;
}

export async function getLocalSnapshot(client, { anchorText }) {
  if (!anchorText || typeof anchorText !== 'string') {
    throw new PageActionError('getLocalSnapshot requires a non-empty anchorText string', 400);
  }
  await client.send('Runtime.enable');
  const { result, exceptionDetails } = await client.send('Runtime.evaluate', {
    expression: buildLocalSnapshotExpression(anchorText),
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new PageActionError(`could not build local snapshot: ${exceptionDetails.text}`, 502);
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

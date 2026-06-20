import { readJsonBody } from '../body.js';
import { badRequest, bodyErrorResponse } from '../errors.js';
import {
  withPage,
  gotoUrl,
  clickSelector,
  typeIntoSelector,
  getPageText,
  getPageSnapshot,
  getLocalSnapshot,
  PageActionError,
} from '../../cdp/page.js';
import { createHandoffGuard } from '../../guards/handoff.js';

function reject(store, label, response) {
  store.recordRejectedAction(label, {
    status: response?.status ?? null,
    reason: response?.body?.error ?? null,
  });
  return response;
}

async function parseJsonBody(req) {
  try {
    return { body: await readJsonBody(req) };
  } catch (err) {
    return { error: err };
  }
}

async function runPageAction(action) {
  try {
    const result = await action();
    return { status: 200, body: { ok: true, ...result } };
  } catch (err) {
    if (err instanceof PageActionError) {
      return { status: err.status, body: { ok: false, code: 'PAGE_ACTION_ERROR', error: err.message } };
    }
    throw err;
  }
}

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

export function gotoRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'goto', bodyErrorResponse(error));
    if (!body || typeof body.url !== 'string' || !body.url.trim()) {
      return reject(store, 'goto', badRequest('body must include a non-empty "url" string'));
    }

    let parsed;
    try {
      parsed = new URL(body.url.trim());
    } catch {
      return reject(store, 'goto', badRequest('URL scheme not allowed: only http and https are permitted'));
    }
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      return reject(store, 'goto', badRequest('URL scheme not allowed: only http and https are permitted'));
    }

    return guard('goto', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      await withPage(session, (client) => gotoUrl(client, body.url), { targetId: targetTab?.id ?? null });
      return { url: body.url };
    }));
  };
}

export function clickRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'click', bodyErrorResponse(error));
    if (!body || typeof body.selector !== 'string' || !body.selector.trim()) {
      return reject(store, 'click', badRequest('body must include a non-empty "selector" string'));
    }

    return guard('click', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      await withPage(session, (client) => clickSelector(client, body.selector), { targetId: targetTab?.id ?? null });
      return { selector: body.selector };
    }));
  };
}

export function typeRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'type', bodyErrorResponse(error));
    if (!body || typeof body.selector !== 'string' || !body.selector.trim()) {
      return reject(store, 'type', badRequest('body must include a non-empty "selector" string'));
    }
    if (typeof body.text !== 'string') {
      return reject(store, 'type', badRequest('body must include a "text" string'));
    }

    return guard('type', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      await withPage(session, (client) => typeIntoSelector(client, body.selector, body.text), { targetId: targetTab?.id ?? null });
      return { selector: body.selector };
    }));
  };
}

export function urlRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async () => {
    return guard('read:url', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      const target = (targetTab?.id != null)
        ? await session.getTargetById(targetTab.id)
        : await session.getFirstPageTarget();
      return { url: target.url };
    }));
  };
}

export function textRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async () => {
    return guard('read:text', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      const text = await withPage(session, (client) => getPageText(client), { targetId: targetTab?.id ?? null });
      return { text };
    }));
  };
}

export function snapshotRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async () => {
    return guard('read:snapshot', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      const snapshot = await withPage(session, (client) => getPageSnapshot(client), { targetId: targetTab?.id ?? null });
      return { snapshot };
    }));
  };
}

export function localSnapshotRoute({ store, session }) {
  const guard = createHandoffGuard({ store, session });
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'read:local-snapshot', bodyErrorResponse(error));
    if (!body || typeof body.anchorText !== 'string' || !body.anchorText.trim()) {
      return reject(store, 'read:local-snapshot', badRequest('body must include a non-empty "anchorText" string'));
    }

    return guard('read:local-snapshot', () => runPageAction(async () => {
      const { targetTab } = store.getState();
      const snapshot = await withPage(
        session,
        (client) => getLocalSnapshot(client, { anchorText: body.anchorText.trim() }),
        { targetId: targetTab?.id ?? null }
      );
      return { snapshot };
    }));
  };
}

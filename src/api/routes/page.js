import { readJsonBody, BodyTooLargeError } from '../body.js';
import {
  withPage,
  gotoUrl,
  clickSelector,
  typeIntoSelector,
  getPageText,
  getPageSnapshot,
  PageActionError,
} from '../../cdp/page.js';

function notAttached() {
  return { status: 503, body: { ok: false, error: 'not attached to Chrome' } };
}

function paused() {
  return { status: 409, body: { ok: false, error: 'bridge is paused; call POST /control/resume before issuing page actions' } };
}

function badRequest(message) {
  return { status: 400, body: { ok: false, error: message } };
}

function tooLarge(message) {
  return { status: 413, body: { ok: false, error: message } };
}

function bodyErrorResponse(error) {
  return error instanceof BodyTooLargeError ? tooLarge(error.message) : badRequest(error.message);
}

function isAttached(store, session) {
  return store.getState().attached && Boolean(session);
}

function isPaused(store) {
  return store.getState().controlState === 'PAUSED';
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
      return { status: err.status, body: { ok: false, error: err.message } };
    }
    throw err;
  }
}

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

export function gotoRoute({ store, session }) {
  return async (req) => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);
    if (!body || typeof body.url !== 'string' || !body.url.trim()) {
      return badRequest('body must include a non-empty "url" string');
    }

    let parsed;
    try {
      parsed = new URL(body.url.trim());
    } catch {
      return badRequest('URL scheme not allowed: only http and https are permitted');
    }
    if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      return badRequest('URL scheme not allowed: only http and https are permitted');
    }

    return runPageAction(async () => {
      await withPage(session, (client) => gotoUrl(client, body.url));
      return { url: body.url };
    });
  };
}

export function clickRoute({ store, session }) {
  return async (req) => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);
    if (!body || typeof body.selector !== 'string' || !body.selector.trim()) {
      return badRequest('body must include a non-empty "selector" string');
    }

    return runPageAction(async () => {
      await withPage(session, (client) => clickSelector(client, body.selector));
      return { selector: body.selector };
    });
  };
}

export function typeRoute({ store, session }) {
  return async (req) => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);
    if (!body || typeof body.selector !== 'string' || !body.selector.trim()) {
      return badRequest('body must include a non-empty "selector" string');
    }
    if (typeof body.text !== 'string') {
      return badRequest('body must include a "text" string');
    }

    return runPageAction(async () => {
      await withPage(session, (client) => typeIntoSelector(client, body.selector, body.text));
      return { selector: body.selector };
    });
  };
}

export function urlRoute({ store, session }) {
  return async () => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    return runPageAction(async () => {
      const target = await session.getFirstPageTarget();
      return { url: target.url };
    });
  };
}

export function textRoute({ store, session }) {
  return async () => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    return runPageAction(async () => {
      const text = await withPage(session, (client) => getPageText(client));
      return { text };
    });
  };
}

export function snapshotRoute({ store, session }) {
  return async () => {
    if (isPaused(store)) return paused();
    if (!isAttached(store, session)) return notAttached();

    return runPageAction(async () => {
      const snapshot = await withPage(session, (client) => getPageSnapshot(client));
      return { snapshot };
    });
  };
}

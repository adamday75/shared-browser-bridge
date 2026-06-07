import { readJsonBody, BodyTooLargeError } from '../body.js';
import { TransitionError } from '../../state/store.js';

const PAUSEABLE_STATES = new Set(['ATTACHED', 'AGENT_ACTIVE', 'HUMAN_ACTIVE']);

function badRequest(message) {
  return { status: 400, body: { ok: false, error: message } };
}

function tooLarge(message) {
  return { status: 413, body: { ok: false, error: message } };
}

function bodyErrorResponse(error) {
  return error instanceof BodyTooLargeError ? tooLarge(error.message) : badRequest(error.message);
}

async function parseJsonBody(req) {
  try {
    return { body: await readJsonBody(req) };
  } catch (err) {
    return { error: err };
  }
}

export function pauseRoute({ store }) {
  return async (req) => {
    let reason = null;
    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return badRequest('body must be a JSON object');
      }
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        return badRequest('"reason" must be a string');
      }
      reason = (typeof body.reason === 'string' && body.reason.trim()) ? body.reason.trim() : null;
    }

    const { controlState } = store.getState();
    if (controlState === 'PAUSED') {
      return { status: 409, body: { ok: false, error: 'already paused', controlState } };
    }
    if (!PAUSEABLE_STATES.has(controlState)) {
      return { status: 409, body: { ok: false, error: `cannot pause from state: ${controlState}`, controlState } };
    }

    try {
      store.transition('PAUSED', { reason });
      return { status: 200, body: { ok: true, controlState: 'PAUSED', reason } };
    } catch (err) {
      if (err instanceof TransitionError) {
        return { status: 409, body: { ok: false, error: err.message } };
      }
      throw err;
    }
  };
}

export function resumeRoute({ store }) {
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return badRequest('body must be a JSON object');
      }
      if (Object.keys(body).length > 0) {
        return badRequest('resume does not accept any request fields');
      }
    }

    const { controlState } = store.getState();
    if (controlState !== 'PAUSED') {
      return { status: 409, body: { ok: false, error: `cannot resume from state: ${controlState}`, controlState } };
    }

    try {
      store.transition('ATTACHED');
      return { status: 200, body: { ok: true, controlState: 'ATTACHED' } };
    } catch (err) {
      if (err instanceof TransitionError) {
        return { status: 409, body: { ok: false, error: err.message } };
      }
      throw err;
    }
  };
}

export function controlStateRoute({ store }) {
  return async () => {
    const { controlState, pauseReason, lastAgentAction, lastHumanActivity, error, chrome } = store.getState();
    return {
      status: 200,
      body: {
        ok: true,
        controlState,
        pauseReason,
        lastAgentAction,
        lastHumanActivity,
        error,
        chrome: chrome ? { mode: chrome.mode, endpoint: chrome.endpoint } : null,
      },
    };
  };
}

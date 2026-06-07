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
      store.recordHumanActivity('manual-pause', { reason });
      return { status: 200, body: { ok: true, controlState: 'PAUSED', reason } };
    } catch (err) {
      if (err instanceof TransitionError) {
        return { status: 409, body: { ok: false, error: err.message } };
      }
      throw err;
    }
  };
}

export function resumeRoute({ store, session }) {
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return bodyErrorResponse(error);

    let force = false;
    let adoptCurrentTarget = false;
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return badRequest('body must be a JSON object');
      }
      const allowedKeys = new Set(['force', 'adoptCurrentTarget']);
      const unknown = Object.keys(body).filter((k) => !allowedKeys.has(k));
      if (unknown.length > 0) {
        return badRequest(`resume does not accept field(s): ${unknown.join(', ')}`);
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        return badRequest('"force" must be a boolean');
      }
      if (body.adoptCurrentTarget !== undefined && typeof body.adoptCurrentTarget !== 'boolean') {
        return badRequest('"adoptCurrentTarget" must be a boolean');
      }
      force = body.force === true;
      adoptCurrentTarget = body.adoptCurrentTarget === true;
    }

    const { controlState, targetTab, lastAgentAction } = store.getState();
    if (controlState !== 'PAUSED') {
      return { status: 409, body: { ok: false, error: `cannot resume from state: ${controlState}`, controlState } };
    }

    // Explicit adopt path: caller accepts that the observable browser target may
    // have changed and intentionally takes the current target as the new baseline.
    // This is the preferred explicit path over generic force when drift is real.
    if (adoptCurrentTarget) {
      if (!session) {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'cannot adopt current target: no session available',
            controlState: 'PAUSED',
          },
        };
      }
      let currentTarget;
      try {
        currentTarget = await session.getFirstPageTarget();
      } catch {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'cannot adopt current target: CDP target lookup failed',
            controlState: 'PAUSED',
          },
        };
      }
      try {
        store.transition('ATTACHED');
        store.recordTargetTab({ id: currentTarget.id, url: currentTarget.url, title: currentTarget.title });
        store.recordHumanActivity('manual-resume', { reason: 'adopted current target' });
        return {
          status: 200,
          body: {
            ok: true,
            controlState: 'ATTACHED',
            adoptedTarget: { id: currentTarget.id, url: currentTarget.url, title: currentTarget.title },
          },
        };
      } catch (err) {
        if (err instanceof TransitionError) {
          return { status: 409, body: { ok: false, error: err.message } };
        }
        throw err;
      }
    }

    // Fresh-state check: if the agent previously acted, require either a stored
    // observable page-target baseline or an explicit override before resume.
    // This is not true focus/current-tab detection; it is a small honest guard
    // against resuming blindly from stale bridge state.
    if (!force && lastAgentAction && !targetTab) {
      return {
        status: 409,
        body: {
          ok: false,
          error: 'cannot verify browser state before resume because no observable target baseline was recorded; pass {"adoptCurrentTarget":true} to accept current browser state and resume, or {"force":true} to skip all checks',
          controlState: 'PAUSED',
        },
      };
    }

    if (!force && targetTab) {
      if (!session) {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'cannot verify browser state before resume; pass {"adoptCurrentTarget":true} to accept current browser state and resume, or {"force":true} to skip all checks',
            controlState: 'PAUSED',
          },
        };
      }

      let currentTarget;
      try {
        currentTarget = await session.getFirstPageTarget();
      } catch {
        return {
          status: 409,
          body: {
            ok: false,
            error: 'cannot verify browser state before resume; pass {"adoptCurrentTarget":true} to accept current browser state and resume, or {"force":true} to skip all checks',
            controlState: 'PAUSED',
          },
        };
      }

      const urlChanged = currentTarget.url !== targetTab.url;
      const tabChanged = currentTarget.id !== targetTab.id;
      if (urlChanged || tabChanged) {
        store.recordHumanActivity('observable-target-drift', {
          reason: tabChanged
            ? `first page target id changed: ${targetTab.id} -> ${currentTarget.id}`
            : `first page target url changed: ${targetTab.url} -> ${currentTarget.url}`,
        });
        return {
          status: 409,
          body: {
            ok: false,
            error: 'observable browser target changed since the last agent baseline; pass {"adoptCurrentTarget":true} to accept the new target and resume, or {"force":true} to resume without updating the baseline',
            drift: {
              expectedTabId: targetTab.id,
              expectedUrl: targetTab.url,
              currentTabId: currentTarget.id,
              currentUrl: currentTarget.url,
            },
            controlState: 'PAUSED',
          },
        };
      }
    }

    try {
      store.transition('ATTACHED');
      store.recordHumanActivity('manual-resume', { reason: force ? 'forced' : null });
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
    const { controlState, pauseReason, lastAgentAction, lastHumanActivity, targetTab, error, chrome } = store.getState();
    return {
      status: 200,
      body: {
        ok: true,
        controlState,
        pauseReason,
        lastAgentAction,
        lastHumanActivity,
        targetTab,
        error,
        chrome: chrome ? { mode: chrome.mode, endpoint: chrome.endpoint } : null,
      },
    };
  };
}

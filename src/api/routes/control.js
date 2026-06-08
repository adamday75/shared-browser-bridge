import { readJsonBody, BodyTooLargeError } from '../body.js';
import { TransitionError } from '../../state/store.js';
import { CdpConnectionError, NoPageTargetError } from '../../cdp/session.js';

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

async function getCurrentTargetForResume({ store, session, label, missingTargetMessage }) {
  try {
    return await session.getFirstPageTarget();
  } catch (err) {
    if (err instanceof CdpConnectionError) {
      try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
      throw reject(store, label, {
        status: 503,
        body: { ok: false, error: err.message, controlState: 'ERROR' },
      });
    }
    if (err instanceof NoPageTargetError) {
      store.clearTargetTab();
      try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
      throw reject(store, label, {
        status: 409,
        body: { ok: false, error: missingTargetMessage ?? err.message, controlState: 'ERROR' },
      });
    }
    throw err;
  }
}

export function pauseRoute({ store }) {
  return async (req) => {
    let reason = null;
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'control:pause', bodyErrorResponse(error));
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reject(store, 'control:pause', badRequest('body must be a JSON object'));
      }
      if (body.reason !== undefined && typeof body.reason !== 'string') {
        return reject(store, 'control:pause', badRequest('"reason" must be a string'));
      }
      reason = (typeof body.reason === 'string' && body.reason.trim()) ? body.reason.trim() : null;
    }

    const { controlState } = store.getState();
    if (controlState === 'PAUSED') {
      return reject(store, 'control:pause', { status: 409, body: { ok: false, error: 'already paused', controlState } });
    }
    if (!PAUSEABLE_STATES.has(controlState)) {
      return reject(store, 'control:pause', { status: 409, body: { ok: false, error: `cannot pause from state: ${controlState}`, controlState } });
    }

    try {
      store.transition('PAUSED', { reason });
      store.recordHumanActivity('manual-pause', { reason });
      return { status: 200, body: { ok: true, controlState: 'PAUSED', reason } };
    } catch (err) {
      if (err instanceof TransitionError) {
        return reject(store, 'control:pause', { status: 409, body: { ok: false, error: err.message } });
      }
      throw err;
    }
  };
}

export function resumeRoute({ store, session }) {
  return async (req) => {
    const { body, error } = await parseJsonBody(req);
    if (error) return reject(store, 'control:resume', bodyErrorResponse(error));

    let force = false;
    let adoptCurrentTarget = false;
    if (body !== null) {
      if (typeof body !== 'object' || Array.isArray(body)) {
        return reject(store, 'control:resume', badRequest('body must be a JSON object'));
      }
      const allowedKeys = new Set(['force', 'adoptCurrentTarget']);
      const unknown = Object.keys(body).filter((k) => !allowedKeys.has(k));
      if (unknown.length > 0) {
        return reject(store, 'control:resume', badRequest(`resume does not accept field(s): ${unknown.join(', ')}`));
      }
      if (body.force !== undefined && typeof body.force !== 'boolean') {
        return reject(store, 'control:resume', badRequest('"force" must be a boolean'));
      }
      if (body.adoptCurrentTarget !== undefined && typeof body.adoptCurrentTarget !== 'boolean') {
        return reject(store, 'control:resume', badRequest('"adoptCurrentTarget" must be a boolean'));
      }
      force = body.force === true;
      adoptCurrentTarget = body.adoptCurrentTarget === true;
    }

    const { controlState, targetTab, lastAgentAction } = store.getState();
    if (controlState !== 'PAUSED') {
      return reject(store, 'control:resume', { status: 409, body: { ok: false, error: `cannot resume from state: ${controlState}`, controlState } });
    }

    // Explicit adopt path: caller accepts that the observable browser target may
    // have changed and intentionally takes the current target as the new baseline.
    // This is the preferred explicit path over generic force when drift is real.
    if (adoptCurrentTarget) {
      if (!session) {
        return reject(store, 'control:resume', {
          status: 409,
          body: {
            ok: false,
            error: 'cannot adopt current target: no session available',
            controlState: 'PAUSED',
          },
        });
      }
      let currentTarget;
      try {
        currentTarget = await getCurrentTargetForResume({
          store,
          session,
          label: 'control:resume',
          missingTargetMessage: 'cannot adopt current target: no open page tabs are available',
        });
      } catch (response) {
        if (response?.status) return response;
        throw response;
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
          return reject(store, 'control:resume', { status: 409, body: { ok: false, error: err.message } });
        }
        throw err;
      }
    }

    // Fresh-state check: if the agent previously acted, require either a stored
    // observable page-target baseline or an explicit override before resume.
    // This is not true focus/current-tab detection; it is a small honest guard
    // against resuming blindly from stale bridge state.
    if (!force && lastAgentAction && !targetTab) {
      return reject(store, 'control:resume', {
        status: 409,
        body: {
          ok: false,
          error: 'cannot verify browser state before resume because no observable target baseline was recorded; pass {"adoptCurrentTarget":true} to accept current browser state and resume, or {"force":true} to skip all checks',
          controlState: 'PAUSED',
        },
      });
    }

    if (!force && targetTab) {
      if (!session) {
        return reject(store, 'control:resume', {
          status: 409,
          body: {
            ok: false,
            error: 'cannot verify browser state before resume; pass {"adoptCurrentTarget":true} to accept current browser state and resume, or {"force":true} to skip all checks',
            controlState: 'PAUSED',
          },
        });
      }

      let currentTarget;
      try {
        currentTarget = await getCurrentTargetForResume({
          store,
          session,
          label: 'control:resume',
          missingTargetMessage: 'cannot verify browser state before resume because no open page tabs are available; open a page and call POST /control/recover, or use {"adoptCurrentTarget":true} after a new page exists',
        });
      } catch (response) {
        if (response?.status) return response;
        throw response;
      }

      const urlChanged = currentTarget.url !== targetTab.url;
      const tabChanged = currentTarget.id !== targetTab.id;
      if (urlChanged || tabChanged) {
        store.recordHumanActivity('observable-target-drift', {
          reason: tabChanged
            ? `first page target id changed: ${targetTab.id} -> ${currentTarget.id}`
            : `first page target url changed: ${targetTab.url} -> ${currentTarget.url}`,
        });
        return reject(store, 'control:resume', {
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
        });
      }
    }

    try {
      store.transition('ATTACHED');
      store.recordHumanActivity('manual-resume', { reason: force ? 'forced' : null });
      return { status: 200, body: { ok: true, controlState: 'ATTACHED' } };
    } catch (err) {
      if (err instanceof TransitionError) {
        return reject(store, 'control:resume', { status: 409, body: { ok: false, error: err.message } });
      }
      throw err;
    }
  };
}

export function recoverRoute({ store, recoverSession, setSession }) {
  return async () => {
    const { controlState } = store.getState();
    if (controlState !== 'ERROR' && controlState !== 'DETACHED') {
      return reject(store, 'control:recover', {
        status: 409,
        body: { ok: false, error: `cannot recover from state: ${controlState}`, controlState },
      });
    }

    try {
      const { chrome, session } = await recoverSession();
      const target = await session.getFirstPageTarget();
      // Guard: a concurrent detach/reset may have changed state while async CDP
      // work was in flight. DETACHED -> ATTACHED is a valid transition, so
      // without this check a stale recover silently undoes an explicit reset.
      const { controlState: nowState } = store.getState();
      if (nowState !== controlState) {
        return reject(store, 'control:recover', {
          status: 409,
          body: { ok: false, error: `recovery superseded: state changed to ${nowState} during CDP work`, controlState: nowState },
        });
      }
      setSession(session);
      store.setAttached(chrome);
      store.recordTargetTab({ id: target.id, url: target.url, title: target.title });
      store.recordHumanActivity('manual-recover', { reason: 'fresh CDP validation passed' });
      return {
        status: 200,
        body: {
          ok: true,
          controlState: 'ATTACHED',
          chrome: { mode: chrome.mode, endpoint: chrome.endpoint },
          targetTab: { id: target.id, url: target.url, title: target.title },
        },
      };
    } catch (err) {
      // Mirror the success-path ownership check: a concurrent action (e.g.
      // POST /control/detach) may have moved us out of the starting state while
      // async CDP work was in flight. Without this guard a failed recover drives
      // DETACHED -> ERROR and undoes the explicit reset.
      const { controlState: nowState } = store.getState();
      if (nowState !== controlState) {
        return reject(store, 'control:recover', {
          status: 409,
          body: { ok: false, error: `recovery superseded: state changed to ${nowState} during CDP work`, controlState: nowState },
        });
      }
      if (err instanceof NoPageTargetError) {
        store.clearTargetTab();
        store.setAttachError(err);
        return reject(store, 'control:recover', { status: 409, body: { ok: false, error: err.message, controlState: 'ERROR' } });
      }
      if (err instanceof CdpConnectionError) {
        store.setAttachError(err);
        return reject(store, 'control:recover', { status: 503, body: { ok: false, error: err.message, controlState: 'ERROR' } });
      }
      if (err instanceof TransitionError) {
        store.setAttachError(err);
        return reject(store, 'control:recover', { status: 503, body: { ok: false, error: err.message, controlState: 'ERROR' } });
      }
      throw err;
    }
  };
}

export function detachRoute({ store, clearSession }) {
  return async () => {
    const { controlState } = store.getState();
    if (controlState === 'DETACHED') {
      return reject(store, 'control:detach', {
        status: 409,
        body: { ok: false, error: 'already detached', controlState },
      });
    }
    if (controlState !== 'ERROR') {
      return reject(store, 'control:detach', {
        status: 409,
        body: { ok: false, error: `detach is only allowed from ERROR; current state is ${controlState}`, controlState },
      });
    }

    clearSession();
    store.setDetached({ reason: 'manual detach' });
    store.recordHumanActivity('manual-detach', { reason: 'reset after error or cleanup' });
    return { status: 200, body: { ok: true, controlState: 'DETACHED' } };
  };
}

export function controlStateRoute({ store }) {
  return async () => {
    const { controlState, pauseReason, lastAgentAction, lastHumanActivity, lastTakeover, targetTab, error, chrome } = store.getState();
    return {
      status: 200,
      body: {
        ok: true,
        controlState,
        pauseReason,
        lastAgentAction,
        lastHumanActivity,
        lastTakeover,
        targetTab,
        error,
        chrome: chrome ? { mode: chrome.mode, endpoint: chrome.endpoint } : null,
      },
    };
  };
}

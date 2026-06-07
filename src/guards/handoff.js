import { TransitionError } from '../state/store.js';
import { CdpConnectionError, NoPageTargetError } from '../cdp/session.js';

function gateForState(controlState, { session }) {
  if (!session || controlState === 'DETACHED') {
    return { status: 503, body: { ok: false, error: 'not attached to Chrome' } };
  }
  if (controlState === 'ERROR') {
    return { status: 409, body: { ok: false, error: 'bridge is in an error state; recover or reattach before issuing page actions' } };
  }
  if (controlState === 'PAUSED') {
    return { status: 409, body: { ok: false, error: 'bridge is paused; call POST /control/resume before issuing page actions' } };
  }
  if (controlState === 'HUMAN_ACTIVE') {
    return { status: 409, body: { ok: false, error: 'human is active; cannot issue agent action' } };
  }
  if (controlState === 'AGENT_ACTIVE') {
    return { status: 409, body: { ok: false, error: 'agent is already active; wait for the current action to finish before issuing another' } };
  }
  return null;
}

export function createHandoffGuard({ store, session }) {
  return async function withAgentAction(label, fn) {
    const { controlState } = store.getState();
    const gated = gateForState(controlState, { session });
    if (gated) return gated;

    // Only ATTACHED may begin a fresh agent action sequence.
    const needsTransition = controlState === 'ATTACHED';
    if (needsTransition) {
      try {
        store.transition('AGENT_ACTIVE');
      } catch (err) {
        if (!(err instanceof TransitionError)) throw err;
        return gateForState(store.getState().controlState, { session })
          ?? { status: 409, body: { ok: false, error: err.message } };
      }
    }

    let result;
    try {
      result = await fn();
    } catch (err) {
      if (err instanceof CdpConnectionError) {
        // Chrome disconnected during the action. Drive into ERROR so the next
        // caller gets an honest gate rather than a misleading ATTACHED state.
        try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
        result = { status: 503, body: { ok: false, error: err.message } };
      } else {
        throw err;
      }
    } finally {
      // Return to ATTACHED only if we were the one who transitioned in.
      // Guard against a concurrent external transition (e.g. pause) having
      // already moved state elsewhere.
      if (needsTransition && store.getState().controlState === 'AGENT_ACTIVE') {
        try {
          store.transition('ATTACHED');
        } catch (err) {
          if (!(err instanceof TransitionError)) throw err;
        }
      }
    }

    // Record the tab baseline the agent just operated on so later resume logic
    // can compare against the same observable CDP surface. If the bridge was
    // externally paused before we got here, do not overwrite the baseline with
    // post-pause browser reality.
    if (store.getState().controlState === 'ATTACHED') {
      try {
        const target = await session.getFirstPageTarget();
        store.recordTargetTab({ id: target.id, url: target.url, title: target.title });
      } catch (err) {
        if (err instanceof CdpConnectionError) {
          try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
          result = { status: 503, body: { ok: false, error: err.message } };
        } else if (err instanceof NoPageTargetError) {
          result = { status: 409, body: { ok: false, error: err.message } };
        } else {
          throw err;
        }
      }
    }

    store.recordAgentAction(label, { status: result?.status ?? null, ok: result?.status === 200 });
    return result;
  };
}

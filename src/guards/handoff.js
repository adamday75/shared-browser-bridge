import { TransitionError } from '../state/store.js';

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

    try {
      const result = await fn();
      store.recordAgentAction(label, { status: result?.status ?? null, ok: result?.status === 200 });
      return result;
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
  };
}

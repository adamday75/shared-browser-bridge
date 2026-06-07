export function createHandoffGuard({ store, session }) {
  return async function withAgentAction(label, fn) {
    const { controlState } = store.getState();

    if (controlState === 'DETACHED' || controlState === 'ERROR' || !session) {
      return { status: 503, body: { ok: false, error: 'not attached to Chrome' } };
    }
    if (controlState === 'PAUSED') {
      return { status: 409, body: { ok: false, error: 'bridge is paused; call POST /control/resume before issuing page actions' } };
    }
    if (controlState === 'HUMAN_ACTIVE') {
      return { status: 409, body: { ok: false, error: 'human is active; cannot issue agent action' } };
    }

    // ATTACHED or AGENT_ACTIVE — only ATTACHED needs an outbound transition.
    const needsTransition = controlState === 'ATTACHED';
    if (needsTransition) store.transition('AGENT_ACTIVE');

    try {
      const result = await fn();
      store.recordAgentAction(label);
      return result;
    } finally {
      // Return to ATTACHED only if we were the one who transitioned in.
      // Guard against a concurrent external transition (e.g. pause) having
      // already moved state elsewhere.
      if (needsTransition && store.getState().controlState === 'AGENT_ACTIVE') {
        store.transition('ATTACHED');
      }
    }
  };
}

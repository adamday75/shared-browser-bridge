const STATES = new Set(['DETACHED', 'ATTACHED', 'AGENT_ACTIVE', 'HUMAN_ACTIVE', 'PAUSED', 'ERROR']);

const VALID_TRANSITIONS = {
  DETACHED:     new Set(['ATTACHED', 'ERROR']),
  ATTACHED:     new Set(['AGENT_ACTIVE', 'HUMAN_ACTIVE', 'PAUSED', 'DETACHED', 'ERROR']),
  AGENT_ACTIVE: new Set(['ATTACHED', 'HUMAN_ACTIVE', 'PAUSED', 'ERROR', 'DETACHED']),
  HUMAN_ACTIVE: new Set(['PAUSED', 'ATTACHED', 'AGENT_ACTIVE', 'ERROR', 'DETACHED']),
  PAUSED:       new Set(['HUMAN_ACTIVE', 'ATTACHED', 'AGENT_ACTIVE', 'DETACHED', 'ERROR']),
  ERROR:        new Set(['DETACHED', 'ATTACHED', 'PAUSED']),
};

export class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionError';
  }
}

export function createStore({ logger = console } = {}) {
  let state = {
    attached: false,
    chrome: null,
    error: null,
    controlState: 'DETACHED',
    pauseReason: null,
    lastAgentAction: null,
    lastHumanActivity: null,
  };

  function getState() {
    return state;
  }

  function setAttached(chrome) {
    const prev = state.controlState;
    state = { ...state, attached: true, chrome, error: null, controlState: 'ATTACHED', pauseReason: null };
    logger.log(`[state] ${prev} -> ATTACHED`);
  }

  function setAttachError(err) {
    const prev = state.controlState;
    state = { ...state, attached: false, chrome: null, error: err.message, controlState: 'ERROR', pauseReason: null };
    logger.log(`[state] ${prev} -> ERROR (${err.message})`);
  }

  function transition(toState, { reason = null } = {}) {
    if (!STATES.has(toState)) throw new TransitionError(`unknown state: ${toState}`);
    const from = state.controlState;
    if (!VALID_TRANSITIONS[from]?.has(toState)) {
      throw new TransitionError(`cannot transition from ${from} to ${toState}`);
    }
    state = {
      ...state,
      controlState: toState,
      attached: toState !== 'DETACHED' && toState !== 'ERROR',
      pauseReason: toState === 'PAUSED' ? (reason ?? null) : null,
      error: toState === 'ERROR' ? (reason ?? null) : null,
    };
    logger.log(`[state] ${from} -> ${toState}${reason ? ` (${reason})` : ''}`);
  }

  function recordAgentAction(label, { status = null, ok = null } = {}) {
    state = { ...state, lastAgentAction: { label, at: new Date().toISOString(), status, ok } };
  }

  function recordHumanActivity(source, { reason = null } = {}) {
    state = { ...state, lastHumanActivity: { source, at: new Date().toISOString(), reason } };
  }

  return { getState, setAttached, setAttachError, transition, recordAgentAction, recordHumanActivity };
}

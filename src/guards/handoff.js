import { TransitionError } from '../state/store.js';
import { CdpConnectionError, NoPageTargetError } from '../cdp/session.js';

function gateForState(controlState, { session }) {
  if (!session || controlState === 'DETACHED') {
    return { status: 503, body: { ok: false, code: 'NOT_ATTACHED', controlState: controlState ?? 'DETACHED', error: 'not attached to Chrome' } };
  }
  if (controlState === 'ERROR') {
    return { status: 409, body: { ok: false, code: 'BRIDGE_ERROR', controlState, error: 'bridge is in an error state; recover or reattach before issuing page actions' } };
  }
  if (controlState === 'PAUSED') {
    return { status: 409, body: { ok: false, code: 'PAUSED', controlState, error: 'bridge is paused; call POST /control/resume before issuing page actions' } };
  }
  if (controlState === 'HUMAN_ACTIVE') {
    return { status: 409, body: { ok: false, code: 'HUMAN_ACTIVE', controlState, error: 'human is active; cannot issue agent action' } };
  }
  if (controlState === 'AGENT_ACTIVE') {
    return { status: 409, body: { ok: false, code: 'AGENT_ACTIVE', controlState, error: 'agent is already active; wait for the current action to finish before issuing another' } };
  }
  return null;
}

export function createHandoffGuard({ store, session }) {
  return async function withAgentAction(label, fn) {
    const { controlState } = store.getState();
    const gated = gateForState(controlState, { session });
    if (gated) {
      store.recordRejectedAction(label, { status: gated.status, reason: gated.body?.error ?? null });
      return gated;
    }

    // Only ATTACHED may begin a fresh agent action sequence.
    const needsTransition = controlState === 'ATTACHED';
    if (needsTransition) {
      try {
        store.transition('AGENT_ACTIVE');
      } catch (err) {
        if (!(err instanceof TransitionError)) throw err;
        const rejected = gateForState(store.getState().controlState, { session })
          ?? { status: 409, body: { ok: false, code: 'STATE_CONFLICT', error: err.message } };
        store.recordRejectedAction(label, { status: rejected.status, reason: rejected.body?.error ?? null });
        return rejected;
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
        result = { status: 503, body: { ok: false, code: 'CDP_ERROR', error: err.message } };
      } else if (err instanceof NoPageTargetError) {
        store.clearTargetTab();
        try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
        result = {
          status: 409,
          body: { ok: false, code: 'NO_PAGE_TARGET', error: err.message, controlState: 'ERROR' },
        };
      } else {
        // Unexpected error: exit AGENT_ACTIVE before re-throwing so the bridge
        // does not get stuck. Baseline is not updated — we do not know where
        // the browser ended up.
        if (needsTransition && store.getState().controlState === 'AGENT_ACTIVE') {
          try { store.transition('ATTACHED'); } catch (transErr) {
            if (!(transErr instanceof TransitionError)) throw transErr;
          }
        }
        throw err;
      }
    }

    // Post-action: update the target baseline BEFORE transitioning to ATTACHED.
    // The poller only fires when controlState === 'ATTACHED'. Staying in
    // AGENT_ACTIVE here means a poll tick cannot misread the just-completed
    // navigation as passive takeover because of baseline update timing.
    if (needsTransition && store.getState().controlState === 'AGENT_ACTIVE') {
      if (result?.status === 200) {
        try {
          const target = await session.getFirstPageTarget();
          // Only write the baseline if we still own AGENT_ACTIVE. A concurrent
          // pause that landed during this fetch must not record post-pause browser
          // reality as the new baseline — that would mask drift on the next resume.
          if (store.getState().controlState === 'AGENT_ACTIVE') {
            store.recordTargetTab({ id: target.id, url: target.url, title: target.title });
          }
        } catch (err) {
          if (err instanceof CdpConnectionError) {
            try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
            store.recordAgentAction(label, { status: result?.status ?? null, ok: false });
            return { status: 503, body: { ok: false, code: 'CDP_ERROR', error: err.message } };
          } else if (err instanceof NoPageTargetError) {
            store.clearTargetTab();
            try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
            store.recordAgentAction(label, { status: result?.status ?? null, ok: false });
            return {
              status: 409,
              body: {
                ok: false,
                code: 'NO_PAGE_TARGET',
                error: err.message,
                controlState: 'ERROR',
                actionMayHaveCompleted: true,
              },
            };
          } else {
            throw err;
          }
        }
      }
      // Re-read state after the async baseline fetch. A concurrent external
      // event (e.g. an explicit pause) may have moved us out of AGENT_ACTIVE
      // while the target fetch was in flight. Only return to ATTACHED if we
      // still own the state slot — same guard the original finally block used.
      if (store.getState().controlState === 'AGENT_ACTIVE') {
        try {
          store.transition('ATTACHED');
        } catch (err) {
          if (!(err instanceof TransitionError)) throw err;
        }
      }
    }

    store.recordAgentAction(label, { status: result?.status ?? null, ok: result?.status === 200 });
    return result;
  };
}

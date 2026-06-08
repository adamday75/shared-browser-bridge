import { CdpConnectionError, NoPageTargetError } from './session.js';
import { TransitionError } from '../state/store.js';

/**
 * Passive takeover detector: polls CDP tab state while ATTACHED or PAUSED and
 * pauses the bridge when observable drift is detected against the stored agent
 * baseline.
 *
 * Drift detection (tab/url comparison) only fires during ATTACHED. While PAUSED
 * the poll still runs to catch CDP disconnects — the bridge cannot honestly claim
 * a usable paused state if the underlying CDP connection or page target is gone.
 *
 * Limitation: detection is disabled during AGENT_ACTIVE because the agent drives
 * navigation itself and we cannot distinguish human from agent changes mid-action.
 * Detection lag equals intervalMs (default 2 s).
 */
export function createTakeoverPoller({ store, session, logger = console, intervalMs = 2000 }) {
  let timer = null;
  let running = false;

  async function poll() {
    const { controlState, targetTab } = store.getState();

    // Run in ATTACHED (drift + connectivity) and PAUSED (connectivity only).
    // Require a stored baseline — without one there is nothing to compare against.
    if ((controlState !== 'ATTACHED' && controlState !== 'PAUSED') || !targetTab) return;

    let current;
    try {
      current = await session.getFirstPageTarget();
    } catch (err) {
      if (err instanceof CdpConnectionError || err instanceof NoPageTargetError) {
        // The bridge cannot honestly remain ATTACHED without a live CDP
        // connection and reachable page target — transition to ERROR.
        if (err instanceof NoPageTargetError) store.clearTargetTab();
        try {
          store.transition('ERROR', { reason: err.message });
        } catch (transErr) {
          if (!(transErr instanceof TransitionError)) throw transErr;
          // Another transition already moved us out of this state — state is safe.
        }
        logger.log(`[takeover-poller] poll error, transitioned to ERROR: ${err.message}`);
        return;
      }
      throw err;
    }

    // Re-read state after the async CDP call. State may have changed (concurrent
    // agent action, explicit pause, etc.) — use the fresh snapshot for comparison.
    // Drift detection only applies during ATTACHED; if we arrived here from PAUSED
    // the connectivity check above was sufficient, so return cleanly.
    const { controlState: stateNow, targetTab: baselineNow } = store.getState();
    if (stateNow !== 'ATTACHED' || !baselineNow) return;

    const urlChanged = current.url !== baselineNow.url;
    const tabChanged = current.id !== baselineNow.id;

    if (!urlChanged && !tabChanged) return;

    const driftReason = tabChanged
      ? `tab id changed: ${baselineNow.id} -> ${current.id}`
      : `url changed: ${baselineNow.url} -> ${current.url}`;

    store.recordTakeover('passive-tab-drift', {
      reason: driftReason,
      expectedTabId: baselineNow.id,
      expectedUrl: baselineNow.url,
      currentTabId: current.id,
      currentUrl: current.url,
    });

    try {
      store.transition('PAUSED', { reason: 'passive-takeover-detected' });
    } catch (err) {
      if (!(err instanceof TransitionError)) throw err;
      // Another transition won the race — state is already safe.
      logger.log(`[takeover-poller] transition lost race: ${err.message}`);
    }
  }

  function schedule() {
    if (!running) return;
    timer = setTimeout(async () => {
      try {
        await poll();
      } catch (err) {
        logger.error(`[takeover-poller] uncaught poll error: ${err.message}`);
      }
      schedule();
    }, intervalMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

import { CdpConnectionError } from '../../cdp/session.js';

export function tabsRoute({ store, session }) {
  return async () => {
    const { attached } = store.getState();
    if (!attached || !session) {
      return {
        status: 503,
        body: { ok: false, code: 'NOT_ATTACHED', error: 'not attached to Chrome' },
      };
    }

    try {
      const tabs = await session.listTabs();
      return {
        status: 200,
        body: { ok: true, count: tabs.length, tabs },
      };
    } catch (err) {
      if (err instanceof CdpConnectionError) {
        try { store.transition('ERROR', { reason: err.message }); } catch { /* ignore re-transition errors */ }
        return {
          status: 503,
          body: { ok: false, code: 'CDP_ERROR', error: err.message },
        };
      }
      throw err;
    }
  };
}

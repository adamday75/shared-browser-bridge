export function tabsRoute({ store, session }) {
  return async () => {
    const { attached } = store.getState();
    if (!attached || !session) {
      return {
        status: 503,
        body: { ok: false, error: 'not attached to Chrome' },
      };
    }

    const tabs = await session.listTabs();
    return {
      status: 200,
      body: { ok: true, count: tabs.length, tabs },
    };
  };
}

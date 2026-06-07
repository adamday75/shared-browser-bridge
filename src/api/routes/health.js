export function healthRoute({ store }) {
  return async () => {
    const { attached, chrome, error } = store.getState();

    return {
      status: 200,
      body: {
        ok: true,
        service: 'shared-browser-bridge',
        attached,
        chrome: chrome
          ? {
              mode: chrome.mode,
              browser: chrome.browser,
              endpoint: chrome.endpoint,
              visible: chrome.userAgent ? !/headless/i.test(chrome.userAgent) : null,
            }
          : null,
        error,
      },
    };
  };
}

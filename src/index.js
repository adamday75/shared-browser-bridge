import { createServer } from './api/server.js';
import { createStore } from './state/store.js';
import { createCdpSession, CdpConnectionError } from './cdp/session.js';
import { createSessionSlot } from './cdp/session-slot.js';
import { createTakeoverPoller } from './cdp/takeover-poller.js';
import { resolveChromeTarget } from './chrome/launcher.js';

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 7820);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_ALLOW_REMOTE_LAUNCH = process.env.CDP_ALLOW_REMOTE_LAUNCH === '1';
const TAKEOVER_POLL_INTERVAL_MS = Number(process.env.TAKEOVER_POLL_INTERVAL_MS || 2000);

async function main() {
  const store = createStore();
  const session = createSessionSlot();

  async function recoverSession() {
    try {
      const chrome = await resolveChromeTarget({
        host: CDP_HOST,
        port: CDP_PORT,
        allowRemoteLaunch: CDP_ALLOW_REMOTE_LAUNCH,
      });
      const nextSession = createCdpSession({ endpoint: chrome.endpoint });
      return { chrome, session: nextSession };
    } catch (err) {
      throw new CdpConnectionError(err.message);
    }
  }

  try {
    const { chrome, session: nextSession } = await recoverSession();
    session.setCurrent(nextSession);
    store.setAttached(chrome);
    // Seed the initial target baseline so the passive takeover poller can
    // detect drift from the very first ATTACHED poll tick. If no page tab
    // exists, the bridge cannot honestly claim it is ready — go to ERROR.
    try {
      const target = await session.getFirstPageTarget();
      store.recordTargetTab({ id: target.id, url: target.url, title: target.title });
      console.log(`[bridge] initial target baseline: ${target.url}`);
    } catch (targetErr) {
      console.error(`[bridge] attached to Chrome but no open page tab: ${targetErr.message}`);
      store.setAttachError(targetErr);
    }
  } catch (err) {
    console.error(`[bridge] Chrome attach failed: ${err.message}`);
    store.setAttachError(err);
  }

  const poller = createTakeoverPoller({ store, session, intervalMs: TAKEOVER_POLL_INTERVAL_MS });
  poller.start();

  const server = createServer({
    store,
    session,
    recoverSession,
    setSession: (nextSession) => session.setCurrent(nextSession),
    clearSession: () => session.clearCurrent(),
  });
  server.listen(PORT, HOST, () => {
    console.log(`[bridge] shared-browser-bridge listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(`[bridge] fatal: ${err.message}`);
  process.exitCode = 1;
});

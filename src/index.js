import { createServer } from './api/server.js';
import { createStore } from './state/store.js';
import { createCdpSession } from './cdp/session.js';
import { resolveChromeTarget } from './chrome/launcher.js';

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 7820);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const CDP_ALLOW_REMOTE_LAUNCH = process.env.CDP_ALLOW_REMOTE_LAUNCH === '1';

async function main() {
  const store = createStore();
  let session = null;

  try {
    const chrome = await resolveChromeTarget({
      host: CDP_HOST,
      port: CDP_PORT,
      allowRemoteLaunch: CDP_ALLOW_REMOTE_LAUNCH,
    });
    store.setAttached(chrome);
    session = createCdpSession({ endpoint: chrome.endpoint });
  } catch (err) {
    console.error(`[bridge] Chrome attach failed: ${err.message}`);
    store.setAttachError(err);
  }

  const server = createServer({ store, session });
  server.listen(PORT, HOST, () => {
    console.log(`[bridge] shared-browser-bridge listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(`[bridge] fatal: ${err.message}`);
  process.exitCode = 1;
});

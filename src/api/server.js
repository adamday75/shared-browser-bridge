import http from 'node:http';
import { healthRoute } from './routes/health.js';
import { tabsRoute } from './routes/tabs.js';
import {
  gotoRoute,
  clickRoute,
  typeRoute,
  urlRoute,
  textRoute,
  snapshotRoute,
} from './routes/page.js';
import { pauseRoute, resumeRoute, recoverRoute, detachRoute, controlStateRoute } from './routes/control.js';
import { checkToken } from './auth.js';

/**
 * Boring local HTTP server: a fixed table of "METHOD path" -> async handler
 * that returns { status, body }. No framework, no remote exposure.
 *
 * Pass apiToken (from BRIDGE_API_TOKEN env var) to require a bearer token on
 * every request. Omit it (or pass null/undefined) for the default open-local
 * behavior.
 */
export function createServer({ store, session, recoverSession, setSession, clearSession, logger = console, apiToken = null }) {
  const routes = {
    'GET /health': healthRoute({ store }),
    'GET /tabs': tabsRoute({ store, session }),
    'POST /page/goto': gotoRoute({ store, session }),
    'POST /page/click': clickRoute({ store, session }),
    'POST /page/type': typeRoute({ store, session }),
    'GET /page/url': urlRoute({ store, session }),
    'GET /page/text': textRoute({ store, session }),
    'GET /page/snapshot': snapshotRoute({ store, session }),
    'POST /control/pause': pauseRoute({ store }),
    'POST /control/resume': resumeRoute({ store, session }),
    'POST /control/recover': recoverRoute({ store, recoverSession, setSession }),
    'POST /control/detach': detachRoute({ store, clearSession }),
    'GET /control/state': controlStateRoute({ store }),
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${pathname}`;
    const handler = routes[key];

    const authFailure = checkToken(req, apiToken);
    if (authFailure) {
      logger.log(`[api] 401 ${key}`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(authFailure.body));
      return;
    }

    if (!handler) {
      logger.log(`[api] 404 ${key}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    try {
      const { status, body } = await handler(req);
      logger.log(`[api] ${key} -> ${status}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch (err) {
      logger.error(`[api] ${key} failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  return server;
}

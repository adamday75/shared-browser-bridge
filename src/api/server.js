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
import { pauseRoute, resumeRoute, controlStateRoute } from './routes/control.js';

/**
 * Boring local HTTP server: a fixed table of "METHOD path" -> async handler
 * that returns { status, body }. No framework, no remote exposure.
 */
export function createServer({ store, session, logger = console }) {
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
    'POST /control/resume': resumeRoute({ store }),
    'GET /control/state': controlStateRoute({ store }),
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${pathname}`;
    const handler = routes[key];

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

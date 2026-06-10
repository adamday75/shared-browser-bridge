#!/usr/bin/env node
/**
 * M4 Build 1 demo: drives the bridge through a minimal end-to-end flow.
 * Requires the bridge to already be running (npm start) with Chrome attached.
 *
 * This demo resumes using adoptCurrentTarget, which operates on the first
 * CDP-listed tab — not necessarily the human-focused tab. For the recommended
 * explicit-target workflow, see scripts/demo-explicit-target-flow.mjs.
 */
import { pathToFileURL } from 'node:url';
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

function createLogger(stdout = process.stdout, stderr = process.stderr) {
  return {
    log(label, detail) {
      stdout.write(`[demo] ${label}: ${detail}\n`);
    },
    fail(label, detail) {
      stderr.write(`[demo] FAIL ${label}: ${detail}\n`);
    },
    unreachable() {
      stderr.write('[demo] bridge not reachable — is it running on http://127.0.0.1:7820?\n');
    },
  };
}

export async function runDemo({
  adapter = createOpenClawAdapter(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const logger = createLogger(stdout, stderr);
  let failed = false;

  async function step(label, fn, { required = true } = {}) {
    try {
      return await fn();
    } catch (err) {
      const msg = err?.message ?? String(err);
      if (required) {
        logger.fail(label, msg);
        failed = true;
      } else {
        logger.log(label, `skipped (${msg})`);
      }
      return null;
    }
  }

  // 1. health
  const healthResult = await step('health', async () => {
    const { status, body } = await adapter.health();
    if (status !== 200 || !body?.ok) {
      logger.fail('health', `status=${status} ok=${body?.ok}`);
      failed = true;
      return null;
    }
    logger.log('health', 'OK');
    return body;
  });

  if (!healthResult) {
    logger.unreachable();
    return 1;
  }

  // 2. initial state
  let initialState;
  await step('state', async () => {
    const { status, body } = await adapter.state();
    if (status !== 200) {
      logger.fail('state', `status=${status}`);
      failed = true;
      return;
    }
    initialState = body.controlState;
    logger.log('initial state', initialState);
  });

  // 3. normalize start state
  if (initialState === 'ERROR' || initialState === 'DETACHED') {
    await step('recover', async () => {
      const { status, body } = await adapter.recover();
      if (status !== 200) {
        logger.fail('recover', `status=${status} error=${body?.error}`);
        failed = true;
        return;
      }
      logger.log('recover', `OK -> ${body.controlState}`);
    });
  } else if (initialState === 'PAUSED') {
    await step('resume (startup)', async () => {
      const { status, body } = await adapter.resume({ adoptCurrentTarget: true });
      if (status !== 200) {
        logger.fail('resume (startup)', `status=${status} error=${body?.error}`);
        failed = true;
        return;
      }
      logger.log('resume (startup)', `OK -> ${body.controlState}`);
    });
  }

  // 4. goto
  await step('goto', async () => {
    const { status, body } = await adapter.goto({ url: 'https://example.com' });
    if (status !== 200) {
      logger.fail('goto', `status=${status} error=${body?.error}`);
      failed = true;
      return;
    }
    logger.log('goto', `OK -> ${body.url ?? 'https://example.com'}`);
  });

  // 5. url
  await step('url', async () => {
    const { status, body } = await adapter.url();
    if (status !== 200) {
      logger.fail('url', `status=${status}`);
      failed = true;
      return;
    }
    logger.log('url', body.url);
  });

  // 6. pause
  await step('pause', async () => {
    const { status, body } = await adapter.pause({ reason: 'demo' });
    if (status !== 200) {
      logger.fail('pause', `status=${status} error=${body?.error}`);
      failed = true;
      return;
    }
    logger.log('pause', `OK -> ${body.controlState}`);
  });

  // 7. state while paused
  await step('state (paused)', async () => {
    const { status, body } = await adapter.state();
    if (status !== 200) {
      logger.fail('state (paused)', `status=${status}`);
      failed = true;
      return;
    }
    logger.log('state while paused', body.controlState);
  });

  // 8. resume
  await step('resume', async () => {
    const { status, body } = await adapter.resume({ adoptCurrentTarget: true });
    if (status !== 200) {
      logger.fail('resume', `status=${status} error=${body?.error}`);
      failed = true;
      return;
    }
    logger.log('resume', `OK -> ${body.controlState}`);
  });

  // 9. final state
  await step('final state', async () => {
    const { status, body } = await adapter.state();
    if (status !== 200) {
      logger.fail('final state', `status=${status}`);
      failed = true;
      return;
    }
    logger.log('final state', body.controlState);
  });

  return failed ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runDemo();
}

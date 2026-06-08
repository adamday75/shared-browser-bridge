import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../scripts/demo-openclaw-flow.mjs';

function createStreams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(chunk) { stdout += chunk; } },
    stderr: { write(chunk) { stderr += chunk; } },
    getStdout() { return stdout; },
    getStderr() { return stderr; },
  };
}

function createAdapter(initialState) {
  const calls = [];
  let stateReads = 0;
  return {
    calls,
    adapter: {
      async health() {
        calls.push('health');
        return { status: 200, body: { ok: true } };
      },
      async state() {
        calls.push('state');
        stateReads += 1;
        if (stateReads === 1) return { status: 200, body: { controlState: initialState } };
        if (stateReads === 2) return { status: 200, body: { controlState: 'PAUSED' } };
        return { status: 200, body: { controlState: 'ATTACHED' } };
      },
      async recover() {
        calls.push('recover');
        return { status: 200, body: { controlState: 'ATTACHED' } };
      },
      async resume(payload) {
        calls.push(`resume:${JSON.stringify(payload)}`);
        return { status: 200, body: { controlState: 'ATTACHED' } };
      },
      async goto({ url }) {
        calls.push(`goto:${url}`);
        return { status: 200, body: { url } };
      },
      async url() {
        calls.push('url');
        return { status: 200, body: { url: 'https://example.com/' } };
      },
      async pause({ reason }) {
        calls.push(`pause:${reason}`);
        return { status: 200, body: { controlState: 'PAUSED' } };
      },
    },
  };
}

test('demo normalizes PAUSED start state before goto', async () => {
  const { adapter, calls } = createAdapter('PAUSED');
  const streams = createStreams();

  const exitCode = await runDemo({ adapter, stdout: streams.stdout, stderr: streams.stderr });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [
    'health',
    'state',
    'resume:{"force":true}',
    'goto:https://example.com',
    'url',
    'pause:demo',
    'state',
    'resume:{"force":true}',
    'state',
  ]);
  assert.match(streams.getStdout(), /\[demo\] resume \(startup\): OK -> ATTACHED/);
  assert.equal(streams.getStderr(), '');
});

test('demo recovers from ERROR start state before goto', async () => {
  const { adapter, calls } = createAdapter('ERROR');
  const streams = createStreams();

  const exitCode = await runDemo({ adapter, stdout: streams.stdout, stderr: streams.stderr });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls.slice(0, 4), [
    'health',
    'state',
    'recover',
    'goto:https://example.com',
  ]);
  assert.match(streams.getStdout(), /\[demo\] recover: OK -> ATTACHED/);
});

test('demo exits non-zero when bridge health check fails', async () => {
  const streams = createStreams();
  const adapter = {
    async health() {
      return { status: 503, body: { ok: false } };
    },
  };

  const exitCode = await runDemo({ adapter, stdout: streams.stdout, stderr: streams.stderr });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /bridge not reachable/);
  assert.match(streams.getStderr(), /FAIL health: status=503 ok=false/);
});

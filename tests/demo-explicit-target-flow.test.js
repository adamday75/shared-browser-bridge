import test from 'node:test';
import assert from 'node:assert/strict';
import { runDemo, parseArgs } from '../scripts/demo-explicit-target-flow.mjs';

function createStreams() {
  let out = '', err = '';
  return {
    stdout: { write(c) { out += c; } },
    stderr: { write(c) { err += c; } },
    getStdout() { return out; },
    getStderr() { return err; },
  };
}

function createAdapter({
  initialState = 'ATTACHED',
  tabs = [{ id: 'T1', url: 'https://example.com', title: 'Example' }],
  healthOk = true,
  recoverResult = null,
  resumeResult = null,
  urlResult = null,
} = {}) {
  const calls = [];
  let state = initialState;
  return {
    calls,
    adapter: {
      async health() {
        calls.push('health');
        return healthOk
          ? { status: 200, body: { ok: true } }
          : { status: 503, body: { ok: false } };
      },
      async state() {
        calls.push('state');
        return { status: 200, body: { controlState: state } };
      },
      async recover() {
        calls.push('recover');
        if (recoverResult) return recoverResult;
        state = 'ATTACHED';
        return { status: 200, body: { ok: true, controlState: 'ATTACHED' } };
      },
      async tabs() {
        calls.push('tabs');
        return { status: 200, body: { ok: true, count: tabs.length, baselineTargetId: null, tabs } };
      },
      async pause() {
        calls.push('pause');
        return { status: 200, body: { ok: true, controlState: 'PAUSED' } };
      },
      async resume({ adoptTargetId } = {}) {
        calls.push(`resume:${adoptTargetId}`);
        if (resumeResult) return resumeResult;
        const tab = tabs.find((t) => t.id === adoptTargetId);
        return { status: 200, body: { ok: true, controlState: 'ATTACHED', adoptedTarget: tab } };
      },
      async url() {
        calls.push('url');
        if (urlResult) return urlResult;
        return { status: 200, body: { url: tabs[0]?.url ?? 'https://example.com' } };
      },
    },
  };
}

test('exits 0 on happy path with --target-id', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStdout(), /PASS/);
  assert.match(streams.getStdout(), /adopted id matches intended/);
  assert.equal(streams.getStderr(), '');
});

test('exits 0 on happy path with --match-url', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com/page', title: 'Example' }],
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { matchUrl: 'example.com' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStdout(), /PASS/);
});

test('exits 0 on happy path with --match-title', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com', title: 'Example Page' }],
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { matchTitle: 'Example' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStdout(), /PASS/);
});

test('skips pause when bridge is already PAUSED', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'PAUSED' });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'resume:T1', 'url']);
  assert.match(streams.getStdout(), /pause: skipped \(already PAUSED\)/);
});

test('recovers from ERROR state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'ERROR' });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStdout(), /recover: -> ATTACHED/);
  assert.match(streams.getStdout(), /PASS/);
});

test('recovers from DETACHED state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'DETACHED' });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url']);
});

test('exits 1 when no selector argument is provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const code = await runDemo({ adapter, args: {}, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /specify one of --target-id, --match-url, or --match-title/);
});

test('exits 1 when multiple selector arguments are provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1', matchUrl: 'example' }, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /specify only one of/);
});

test('exits 1 when health check fails', async () => {
  const { adapter, calls } = createAdapter({ healthOk: false });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 1);
  assert.deepEqual(calls, ['health']);
  assert.match(streams.getStderr(), /FAIL.*health/);
  assert.match(streams.getStderr(), /FAIL/);
});

test('exits 1 when health throws (bridge unreachable)', async () => {
  const streams = createStreams();
  const adapter = {
    async health() { throw new Error('ECONNREFUSED'); },
  };

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /unreachable/);
});

test('exits 1 when target id not found', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'MISSING' }, ...streams });

  assert.equal(code, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs']);
  assert.match(streams.getStderr(), /FAIL.*target selection/);
  assert.match(streams.getStderr(), /no tab with id "MISSING"/);
});

test('exits 1 when match-url finds no tabs', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { matchUrl: 'notfound.com' }, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /no tab with URL containing "notfound.com"/);
});

test('exits 1 when match-url is ambiguous', async () => {
  const { adapter } = createAdapter({
    tabs: [
      { id: 'T1', url: 'https://example.com/a', title: 'A' },
      { id: 'T2', url: 'https://example.com/b', title: 'B' },
    ],
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { matchUrl: 'example.com' }, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /2 tabs match URL "example.com"/);
  assert.match(streams.getStderr(), /be more specific or use --target-id/);
});

test('exits 1 when match-title is ambiguous', async () => {
  const { adapter } = createAdapter({
    tabs: [
      { id: 'T1', url: 'https://a.com', title: 'Example One' },
      { id: 'T2', url: 'https://b.com', title: 'Example Two' },
    ],
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { matchTitle: 'Example' }, ...streams });

  assert.equal(code, 1);
  assert.match(streams.getStderr(), /2 tabs match title "Example"/);
});

test('exits 1 when recover fails', async () => {
  const { adapter, calls } = createAdapter({
    initialState: 'ERROR',
    recoverResult: { status: 503, body: { ok: false, code: 'CDP_ERROR', controlState: 'ERROR' } },
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 1);
  assert.deepEqual(calls, ['health', 'state', 'recover']);
  assert.match(streams.getStderr(), /FAIL.*recover/);
});

test('exits 1 when adoption is rejected by bridge', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 409, body: { ok: false, code: 'TARGET_NOT_FOUND', error: 'no open page target with id: T1' } },
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /FAIL.*adopt/);
});

test('exits 1 when resume succeeds but adoptedTarget is absent from response', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 200, body: { ok: true, controlState: 'ATTACHED' } },
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(code, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /FAIL.*verify adoption/);
  assert.match(streams.getStderr(), /adoptedTarget absent/);
});

test('multi-tab: notes URL discrepancy between adopted and first CDP tab', async () => {
  const tabs = [
    { id: 'T1', url: 'https://first.com', title: 'First' },
    { id: 'T2', url: 'https://second.com', title: 'Second' },
  ];
  const { adapter } = createAdapter({
    tabs,
    urlResult: { status: 200, body: { url: 'https://first.com' } },
  });
  const streams = createStreams();

  const code = await runDemo({ adapter, args: { targetId: 'T2' }, ...streams });

  assert.equal(code, 0);
  assert.match(streams.getStdout(), /adopted tab URL:.*first\.com|second\.com/);
});

test('parseArgs extracts all fields from argv', () => {
  const args = parseArgs([
    '--base-url', 'http://10.0.0.1:9999',
    '--token', 'secret',
    '--target-id', 'ABC',
  ]);
  assert.equal(args.baseUrl, 'http://10.0.0.1:9999');
  assert.equal(args.token, 'secret');
  assert.equal(args.targetId, 'ABC');
  assert.equal(args.matchUrl, null);
  assert.equal(args.matchTitle, null);
});

test('parseArgs defaults when argv is empty', () => {
  const args = parseArgs([]);
  assert.equal(args.baseUrl, 'http://127.0.0.1:7820');
  assert.equal(args.token, null);
  assert.equal(args.targetId, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { runPageBrief, parseArgs } from '../scripts/demo-openclaw-page-brief.mjs';

const SAMPLE_TEXT = 'Example Domain This domain is for use in illustrative examples in documents.';

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
  textResult = null,
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
      async text() {
        calls.push('text');
        if (textResult) return textResult;
        return { status: 200, body: { text: SAMPLE_TEXT } };
      },
    },
  };
}

// --- Happy path ---

test('exits 0 on happy path with --target-id', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const { exitCode, brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
  assert.equal(streams.getStderr(), '');
  assert.ok(brief !== null);
});

test('exits 0 on happy path with --match-url', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com/page', title: 'Example' }],
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { matchUrl: 'example.com' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
});

test('exits 0 on happy path with --match-title', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com', title: 'Example Page' }],
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { matchTitle: 'Example' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
});

// --- Brief structure ---

test('brief has correct shape on happy path', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com', title: 'Example' }],
    urlResult: { status: 200, body: { url: 'https://example.com' } },
    textResult: { status: 200, body: { text: 'Hello world content here.' } },
  });
  const streams = createStreams();

  const { brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.ok, true);
  assert.equal(brief.target.id, 'T1');
  assert.equal(brief.target.title, 'Example');
  assert.equal(brief.target.url, 'https://example.com');
  assert.equal(brief.page.readUrl, 'https://example.com');
  assert.equal(brief.page.textLength, 'Hello world content here.'.length);
  assert.equal(brief.page.excerpt, 'Hello world content here.');
  assert.ok(Array.isArray(brief.page.notes));
  assert.ok(brief.page.notes.length >= 1);
});

test('single-tab brief has no multi-tab note', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com', title: 'Example' }],
  });
  const streams = createStreams();

  const { brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.ok(!brief.page.notes.some((n) => n.includes('multiple tabs')));
});

test('multi-tab brief includes multi-tab note', async () => {
  const { adapter } = createAdapter({
    tabs: [
      { id: 'T1', url: 'https://example.com', title: 'Example' },
      { id: 'T2', url: 'https://other.com', title: 'Other' },
    ],
  });
  const streams = createStreams();

  const { brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.ok, true);
  assert.ok(brief.page.notes.some((n) => n.includes('multiple tabs')));
});

test('brief excerpt truncates long text to 500 chars with ellipsis', async () => {
  const longText = 'x'.repeat(600);
  const { adapter } = createAdapter({
    textResult: { status: 200, body: { text: longText } },
  });
  const streams = createStreams();

  const { brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.page.textLength, 600);
  assert.ok(brief.page.excerpt.endsWith('…'));
  assert.equal(brief.page.excerpt.length, 501);
});

test('brief excerpt collapses internal whitespace', async () => {
  const { adapter } = createAdapter({
    textResult: { status: 200, body: { text: '  hello   world  \n  foo  ' } },
  });
  const streams = createStreams();

  const { brief } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.page.excerpt, 'hello world foo');
});

test('brief JSON appears in stdout', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  const out = streams.getStdout();
  assert.match(out, /--- Page Brief \(JSON\) ---/);
  assert.match(out, /"ok": true/);
  assert.match(out, /"target"/);
  assert.match(out, /"page"/);
  assert.match(out, /--- End ---/);
});

// --- Control flow variants ---

test('skips pause when bridge is already PAUSED', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'PAUSED' });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /pause: skipped \(already PAUSED\)/);
});

test('recovers from ERROR state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'ERROR' });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /recover: -> ATTACHED/);
});

test('recovers from DETACHED state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'DETACHED' });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
});

// --- Failure paths ---

test('exits 1 when no selector argument is provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode, brief } = await runPageBrief({ adapter, args: {}, ...streams });

  assert.equal(exitCode, 1);
  assert.equal(brief, null);
  assert.match(streams.getStderr(), /specify one of --target-id, --match-url, or --match-title/);
});

test('exits 1 when multiple selector arguments are provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1', matchUrl: 'example' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /specify only one of/);
});

test('exits 1 when health check fails', async () => {
  const { adapter, calls } = createAdapter({ healthOk: false });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health']);
  assert.match(streams.getStderr(), /FAIL.*health/);
});

test('exits 1 when health throws (bridge unreachable)', async () => {
  const streams = createStreams();
  const adapter = {
    async health() { throw new Error('ECONNREFUSED'); },
  };

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /unreachable/);
});

test('exits 1 when target id not found', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'MISSING' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs']);
  assert.match(streams.getStderr(), /no tab with id "MISSING"/);
});

test('exits 1 when match-url finds no tabs', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { matchUrl: 'notfound.com' }, ...streams });

  assert.equal(exitCode, 1);
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

  const { exitCode } = await runPageBrief({ adapter, args: { matchUrl: 'example.com' }, ...streams });

  assert.equal(exitCode, 1);
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

  const { exitCode } = await runPageBrief({ adapter, args: { matchTitle: 'Example' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /2 tabs match title "Example"/);
});

test('exits 1 when recover fails', async () => {
  const { adapter, calls } = createAdapter({
    initialState: 'ERROR',
    recoverResult: { status: 503, body: { ok: false, code: 'CDP_ERROR', controlState: 'ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'recover']);
  assert.match(streams.getStderr(), /FAIL.*recover/);
});

test('exits 1 when adoption is rejected by bridge', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 409, body: { ok: false, code: 'TARGET_NOT_FOUND', error: 'no open page target with id: T1' } },
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /FAIL.*adopt/);
});

test('exits 1 when resume succeeds but adoptedTarget is absent', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 200, body: { ok: true, controlState: 'ATTACHED' } },
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /adoptedTarget absent/);
});

test('exits 1 when read/url fails', async () => {
  const { adapter, calls } = createAdapter({
    urlResult: { status: 503, body: { ok: false, code: 'PAGE_ACTION_ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStderr(), /FAIL.*read\/url/);
});

test('exits 1 when read/text fails', async () => {
  const { adapter, calls } = createAdapter({
    textResult: { status: 503, body: { ok: false, code: 'PAGE_ACTION_ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runPageBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text']);
  assert.match(streams.getStderr(), /FAIL.*read\/text/);
});

// --- parseArgs ---

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

test('parseArgs extracts --match-url and --match-title', () => {
  const args = parseArgs(['--match-url', 'example.com', '--match-title', 'Example']);
  assert.equal(args.matchUrl, 'example.com');
  assert.equal(args.matchTitle, 'Example');
  assert.equal(args.targetId, null);
});

test('parseArgs defaults when argv is empty', () => {
  const args = parseArgs([]);
  assert.equal(args.baseUrl, 'http://127.0.0.1:7820');
  assert.equal(args.token, null);
  assert.equal(args.targetId, null);
  assert.equal(args.matchUrl, null);
  assert.equal(args.matchTitle, null);
});

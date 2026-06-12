import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runLinkedInFollowUpBrief,
  parseArgs,
  isLinkedInUrl,
  extractVisibleSignals,
  classifyLinkedInContext,
  generateDrafts,
  VALID_MODES,
} from '../scripts/demo-linkedin-followup-brief.mjs';

const LINKEDIN_POST_TEXT = [
  'Some post content about AI Optimizer.',
  'Like Comment Repost Send',
  '3 comments',
  'Add a comment…',
  'Reply',
  'Great post! This is really interesting.',
  'Replies',
].join('\n');

const LINKEDIN_MINIMAL_TEXT = 'AI Optimizer shared a post. Like Repost Send';

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
  tabs = [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' }],
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
        return { status: 200, body: { url: tabs[0]?.url ?? 'https://www.linkedin.com/feed/' } };
      },
      async text() {
        calls.push('text');
        if (textResult) return textResult;
        return { status: 200, body: { text: LINKEDIN_POST_TEXT } };
      },
    },
  };
}

// --- Happy path ---

test('exits 0 on happy path with --target-id', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
  assert.equal(streams.getStderr(), '');
  assert.ok(brief !== null);
});

test('exits 0 on happy path with --match-url', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'LinkedIn Post' }],
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchUrl: 'linkedin.com' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
});

test('exits 0 on happy path with --match-title', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn Feed' }],
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchTitle: 'LinkedIn' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
});

// --- Brief structure ---

test('brief has correct follow-up shape on happy path', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.ok, true);
  assert.equal(brief.target.id, 'T1');
  assert.equal(brief.target.title, 'LinkedIn');
  assert.equal(brief.target.url, 'https://www.linkedin.com/feed/');

  assert.equal(brief.followUp.surface, 'linkedin');
  assert.equal(brief.followUp.contextType, 'feed');
  assert.equal(brief.followUp.suggestedMode, 'inspect_only');
  assert.deepEqual(brief.followUp.drafts, []);
  assert.equal(brief.followUp.postContext.readUrl, 'https://www.linkedin.com/feed/');
  assert.equal(brief.followUp.postContext.title, 'LinkedIn');
  assert.equal(brief.followUp.postContext.textLength, LINKEDIN_POST_TEXT.length);
  assert.ok(typeof brief.followUp.postContext.excerpt === 'string');

  assert.ok(typeof brief.followUp.visibleSignals.commentsPresent === 'boolean');
  assert.ok(typeof brief.followUp.visibleSignals.commentBoxesVisible === 'boolean');
  assert.ok(typeof brief.followUp.visibleSignals.replyAffordancesVisible === 'boolean');
  assert.ok(typeof brief.followUp.visibleSignals.interactionOpportunities === 'number');

  assert.ok(Array.isArray(brief.followUp.notes));
  assert.ok(brief.followUp.notes.length >= 1);
  assert.ok(Array.isArray(brief.followUp.limitations));
  assert.ok(brief.followUp.limitations.length >= 1);
});

test('brief detects visible signals from LinkedIn post text', async () => {
  const { adapter } = createAdapter({
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.followUp.visibleSignals.commentsPresent, true);
  assert.equal(brief.followUp.visibleSignals.commentBoxesVisible, true);
  assert.equal(brief.followUp.visibleSignals.replyAffordancesVisible, true);
  assert.ok(brief.followUp.visibleSignals.interactionOpportunities >= 1);
});

test('draft_only mode keeps Build 2 boundary and emits bounded drafts', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'LinkedIn Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/example' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1', mode: 'draft_only' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  assert.equal(brief.followUp.contextType, 'thread');
  assert.equal(brief.followUp.suggestedMode, 'draft_only');
  assert.ok(Array.isArray(brief.followUp.drafts));
  assert.equal(brief.followUp.drafts.length, 2);
  assert.deepEqual(
    brief.followUp.drafts.map((draft) => draft.kind),
    ['reply_candidate', 'comment_candidate'],
  );
  assert.match(streams.getStdout(), /mode: draft_only/);
  assert.match(streams.getStdout(), /drafts generated: 2/);
});

test('brief reports no signals for minimal page text', async () => {
  const { adapter } = createAdapter({
    textResult: { status: 200, body: { text: LINKEDIN_MINIMAL_TEXT } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.followUp.visibleSignals.commentsPresent, false);
  assert.equal(brief.followUp.visibleSignals.commentBoxesVisible, false);
  assert.equal(brief.followUp.visibleSignals.replyAffordancesVisible, false);
  assert.equal(brief.followUp.visibleSignals.interactionOpportunities, 0);
});

test('brief adds limitation when readUrl is not LinkedIn', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://example.com', title: 'Example' }],
    urlResult: { status: 200, body: { url: 'https://example.com' } },
    textResult: { status: 200, body: { text: 'not a linkedin page' } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.ok(brief.followUp.limitations.some((l) => l.includes('not appear to be a LinkedIn page')));
});

test('brief does not add non-LinkedIn limitation when readUrl is LinkedIn', async () => {
  const { adapter } = createAdapter({
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/' } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.ok(!brief.followUp.limitations.some((l) => l.includes('not appear to be a LinkedIn page')));
});

test('brief excerpt truncates long text', async () => {
  const longText = 'x'.repeat(600);
  const { adapter } = createAdapter({
    textResult: { status: 200, body: { text: longText } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.followUp.postContext.textLength, 600);
  assert.ok(brief.followUp.postContext.excerpt.endsWith('…'));
  assert.equal(brief.followUp.postContext.excerpt.length, 501);
});

test('brief JSON appears in stdout', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  const out = streams.getStdout();
  assert.match(out, /--- LinkedIn Follow-up Brief \(JSON\) ---/);
  assert.match(out, /"ok": true/);
  assert.match(out, /"followUp"/);
  assert.match(out, /"visibleSignals"/);
  assert.match(out, /--- End ---/);
});

// --- Control flow variants ---

test('skips pause when bridge is already PAUSED', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'PAUSED' });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /pause: skipped \(already PAUSED\)/);
});

test('recovers from ERROR state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'ERROR' });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
  assert.match(streams.getStdout(), /recover: -> ATTACHED/);
});

test('recovers from DETACHED state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'DETACHED' });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'pause']);
});

// --- Failure paths ---

test('exits 1 when no selector argument is provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({ adapter, args: {}, ...streams });

  assert.equal(exitCode, 1);
  assert.equal(brief, null);
  assert.match(streams.getStderr(), /specify one of --target-id, --match-url, or --match-title/);
});

test('exits 1 when multiple selector arguments are provided', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1', matchUrl: 'linkedin' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /specify only one of/);
});

test('exits 1 when mode is invalid', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1', mode: 'act_mode' },
    ...streams,
  });

  assert.equal(exitCode, 1);
  assert.equal(brief, null);
  assert.match(streams.getStderr(), /invalid mode "act_mode"/);
});

test('exits 1 when health check fails', async () => {
  const { adapter, calls } = createAdapter({ healthOk: false });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health']);
  assert.match(streams.getStderr(), /FAIL.*health/);
});

test('exits 1 when health throws (bridge unreachable)', async () => {
  const streams = createStreams();
  const adapter = {
    async health() { throw new Error('ECONNREFUSED'); },
  };

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /unreachable/);
});

test('exits 1 when target id not found', async () => {
  const { adapter, calls } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'MISSING' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs']);
  assert.match(streams.getStderr(), /no tab with id "MISSING"/);
});

test('exits 1 when match-url finds no tabs', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchUrl: 'notfound.com' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /no tab with URL containing "notfound.com"/);
});

test('exits 1 when match-url is ambiguous (multiple LinkedIn tabs)', async () => {
  const { adapter } = createAdapter({
    tabs: [
      { id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'Feed' },
      { id: 'T2', url: 'https://www.linkedin.com/posts/example', title: 'Post' },
    ],
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchUrl: 'linkedin.com' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /2 tabs match URL "linkedin.com"/);
  assert.match(streams.getStderr(), /be more specific or use --target-id/);
});

test('exits 1 when match-title is ambiguous', async () => {
  const { adapter } = createAdapter({
    tabs: [
      { id: 'T1', url: 'https://www.linkedin.com/a', title: 'LinkedIn Feed' },
      { id: 'T2', url: 'https://www.linkedin.com/b', title: 'LinkedIn Post' },
    ],
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchTitle: 'LinkedIn' }, ...streams });

  assert.equal(exitCode, 1);
  assert.match(streams.getStderr(), /2 tabs match title "LinkedIn"/);
});

test('exits 1 when recover fails', async () => {
  const { adapter, calls } = createAdapter({
    initialState: 'ERROR',
    recoverResult: { status: 503, body: { ok: false, code: 'CDP_ERROR', controlState: 'ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'recover']);
  assert.match(streams.getStderr(), /FAIL.*recover/);
});

test('exits 1 when adoption is rejected by bridge', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 409, body: { ok: false, code: 'TARGET_NOT_FOUND', error: 'no open page target with id: T1' } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /FAIL.*adopt/);
});

test('exits 1 when resume succeeds but adoptedTarget is absent', async () => {
  const { adapter, calls } = createAdapter({
    resumeResult: { status: 200, body: { ok: true, controlState: 'ATTACHED' } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1']);
  assert.match(streams.getStderr(), /adoptedTarget absent/);
});

test('exits 1 when read/url fails', async () => {
  const { adapter, calls } = createAdapter({
    urlResult: { status: 503, body: { ok: false, code: 'PAGE_ACTION_ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url']);
  assert.match(streams.getStderr(), /FAIL.*read\/url/);
});

test('exits 1 when read/text fails', async () => {
  const { adapter, calls } = createAdapter({
    textResult: { status: 503, body: { ok: false, code: 'PAGE_ACTION_ERROR' } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text']);
  assert.match(streams.getStderr(), /FAIL.*read\/text/);
});

// --- isLinkedInUrl ---

test('isLinkedInUrl returns true for www.linkedin.com', () => {
  assert.equal(isLinkedInUrl('https://www.linkedin.com/feed/'), true);
  assert.equal(isLinkedInUrl('https://www.linkedin.com/posts/example'), true);
});

test('isLinkedInUrl returns true for linkedin.com without www', () => {
  assert.equal(isLinkedInUrl('https://linkedin.com/in/someone'), true);
});

test('isLinkedInUrl returns false for non-LinkedIn URLs', () => {
  assert.equal(isLinkedInUrl('https://example.com'), false);
  assert.equal(isLinkedInUrl('https://notlinkedin.com'), false);
});

test('isLinkedInUrl returns false for null/undefined/invalid', () => {
  assert.equal(isLinkedInUrl(null), false);
  assert.equal(isLinkedInUrl(undefined), false);
  assert.equal(isLinkedInUrl('not a url'), false);
});

// --- extractVisibleSignals ---

test('extractVisibleSignals detects all signals in rich post text', () => {
  const signals = extractVisibleSignals(LINKEDIN_POST_TEXT);
  assert.equal(signals.commentsPresent, true);
  assert.equal(signals.commentBoxesVisible, true);
  assert.equal(signals.replyAffordancesVisible, true);
  assert.ok(signals.interactionOpportunities >= 1);
});

test('extractVisibleSignals returns zeros for empty text', () => {
  const signals = extractVisibleSignals('');
  assert.equal(signals.commentsPresent, false);
  assert.equal(signals.commentBoxesVisible, false);
  assert.equal(signals.replyAffordancesVisible, false);
  assert.equal(signals.interactionOpportunities, 0);
});

test('extractVisibleSignals returns zeros for null', () => {
  const signals = extractVisibleSignals(null);
  assert.equal(signals.commentsPresent, false);
  assert.equal(signals.interactionOpportunities, 0);
});

// --- Build 2 helpers ---

test('classifyLinkedInContext distinguishes feed post thread profile and unknown', () => {
  assert.equal(classifyLinkedInContext('https://www.linkedin.com/feed/', ''), 'feed');
  assert.equal(classifyLinkedInContext('https://www.linkedin.com/in/someone', ''), 'profile');
  assert.equal(classifyLinkedInContext('https://www.linkedin.com/posts/example', LINKEDIN_MINIMAL_TEXT), 'post');
  assert.equal(classifyLinkedInContext('https://www.linkedin.com/posts/example', LINKEDIN_POST_TEXT), 'thread');
  assert.equal(classifyLinkedInContext('https://example.com', ''), 'unknown');
});

test('generateDrafts stays bounded and context-specific', () => {
  const drafts = generateDrafts({
    contextType: 'thread',
    excerpt: 'Some post content about AI Optimizer.',
    signals: extractVisibleSignals(LINKEDIN_POST_TEXT),
    title: 'LinkedIn Post',
  });

  assert.equal(drafts.length, 2);
  assert.deepEqual(
    drafts.map((draft) => draft.kind),
    ['reply_candidate', 'comment_candidate'],
  );
});

// --- parseArgs ---

test('parseArgs extracts all fields from argv', () => {
  const args = parseArgs([
    '--base-url', 'http://10.0.0.1:9999',
    '--token', 'secret',
    '--target-id', 'ABC',
    '--mode', 'draft_only',
  ]);
  assert.equal(args.baseUrl, 'http://10.0.0.1:9999');
  assert.equal(args.token, 'secret');
  assert.equal(args.targetId, 'ABC');
  assert.equal(args.mode, 'draft_only');
  assert.equal(args.matchUrl, null);
  assert.equal(args.matchTitle, null);
});

test('parseArgs extracts --match-url and --match-title', () => {
  const args = parseArgs(['--match-url', 'linkedin.com', '--match-title', 'LinkedIn']);
  assert.equal(args.matchUrl, 'linkedin.com');
  assert.equal(args.matchTitle, 'LinkedIn');
  assert.equal(args.targetId, null);
});

test('parseArgs defaults when argv is empty', () => {
  const args = parseArgs([]);
  assert.equal(args.baseUrl, 'http://127.0.0.1:7820');
  assert.equal(args.token, null);
  assert.equal(args.targetId, null);
  assert.equal(args.matchUrl, null);
  assert.equal(args.matchTitle, null);
  assert.equal(args.mode, 'inspect_only');
});

test('VALID_MODES preserves inspect_only and draft_only boundary', () => {
  assert.deepEqual(VALID_MODES, ['inspect_only', 'draft_only']);
});

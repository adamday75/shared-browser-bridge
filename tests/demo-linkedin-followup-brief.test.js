import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runLinkedInFollowUpBrief,
  parseArgs,
  isLinkedInUrl,
  extractVisibleSignals,
  classifyLinkedInContext,
  generateDrafts,
  extractSnapshotText,
  extractRawSnapshotText,
  buildSnapshotDebugDump,
  isLinkedInNoise,
  computeContentQuality,
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

const DEFAULT_SNAPSHOT_ELEMENTS = [
  { tag: 'h2', text: 'Some post content about AI Optimizer', id: null },
  { tag: 'a', text: 'Like', id: null },
  { tag: 'a', text: 'Comment', id: null },
  { tag: 'button', text: 'Reply', id: null },
  { tag: 'a', text: 'Great post! This is really interesting discussion about optimization and it continues here', id: null },
];

function createAdapter({
  initialState = 'ATTACHED',
  tabs = [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' }],
  healthOk = true,
  recoverResult = null,
  resumeResult = null,
  urlResult = null,
  textResult = null,
  snapshotResult = null,
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
      async snapshot() {
        calls.push('snapshot');
        if (snapshotResult) return snapshotResult;
        return { status: 200, body: { snapshot: DEFAULT_SNAPSHOT_ELEMENTS } };
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
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
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
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
  assert.match(streams.getStdout(), /PASS/);
});

test('exits 0 on happy path with --match-title', async () => {
  const { adapter, calls } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn Feed' }],
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { matchTitle: 'LinkedIn' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
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
    snapshotResult: { status: 200, body: { snapshot: [] } },
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
  assert.deepEqual(calls, ['health', 'state', 'tabs', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
  assert.match(streams.getStdout(), /pause: skipped \(already PAUSED\)/);
});

test('recovers from ERROR state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'ERROR' });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
  assert.match(streams.getStdout(), /recover: -> ATTACHED/);
});

test('recovers from DETACHED state before adopting', async () => {
  const { adapter, calls } = createAdapter({ initialState: 'DETACHED' });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ['health', 'state', 'recover', 'tabs', 'pause', 'resume:T1', 'url', 'text', 'snapshot', 'pause']);
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

// --- Build 4: De-noise behavior ---

test('isLinkedInNoise catches exact chrome terms', () => {
  assert.equal(isLinkedInNoise('Like'), true);
  assert.equal(isLinkedInNoise('Comment'), true);
  assert.equal(isLinkedInNoise('Repost'), true);
  assert.equal(isLinkedInNoise('Follow'), true);
  assert.equal(isLinkedInNoise('People also viewed'), true);
  assert.equal(isLinkedInNoise('Add to your feed'), true);
  assert.equal(isLinkedInNoise('LinkedIn News'), true);
  assert.equal(isLinkedInNoise('View profile'), true);
  assert.equal(isLinkedInNoise('Privacy Policy'), true);
});

test('isLinkedInNoise catches count patterns', () => {
  assert.equal(isLinkedInNoise('3 comments'), true);
  assert.equal(isLinkedInNoise('12 likes'), true);
  assert.equal(isLinkedInNoise('1,234 followers'), true);
  assert.equal(isLinkedInNoise('5 reactions'), true);
});

test('isLinkedInNoise catches sidebar/profile patterns', () => {
  assert.equal(isLinkedInNoise('View all 5'), true);
  assert.equal(isLinkedInNoise('See more'), true);
  assert.equal(isLinkedInNoise('posted 2d ago'), true);
  assert.equal(isLinkedInNoise('shared 1w ago'), true);
  assert.equal(isLinkedInNoise('Senior Software Engineer at Company'), true);
});

test('isLinkedInNoise does not flag real content', () => {
  assert.equal(isLinkedInNoise('This is a thoughtful discussion about AI optimization strategies'), false);
  assert.equal(isLinkedInNoise('We just shipped a new feature that reduces latency by 40%'), false);
});

test('extractSnapshotText filters short anchor tags as nav noise', () => {
  const elements = [
    { tag: 'h2', text: 'Important post about machine learning models', id: null },
    { tag: 'a', text: 'John Smith', id: null },           // short anchor = nav
    { tag: 'a', text: 'View profile', id: null },          // noise exact match
    { tag: 'a', text: 'AI Startup Co', id: null },         // short anchor = nav
    { tag: 'a', text: 'This is a genuinely insightful comment about the implications of this research', id: null }, // long anchor = content
  ];
  const result = extractSnapshotText(elements);
  assert.ok(result.includes('Important post about machine learning models'));
  assert.ok(!result.includes('John Smith'));
  assert.ok(!result.includes('View profile'));
  assert.ok(!result.includes('AI Startup Co'));
  assert.ok(result.includes('genuinely insightful comment'));
});

test('extractSnapshotText filters button/nav tags with raised threshold', () => {
  const elements = [
    { tag: 'h2', text: 'Post content here', id: null },
    { tag: 'button', text: 'Show more comments', id: null },   // < 40 chars, noise tag
    { tag: 'button', text: 'Sign in to see who liked this', id: null }, // < 40 chars, noise tag
    { tag: 'nav', text: 'Home My Network Jobs', id: null },    // < 40 chars, noise tag
  ];
  const result = extractSnapshotText(elements);
  assert.ok(result.includes('Post content here'));
  assert.ok(!result.includes('Show more comments'));
  assert.ok(!result.includes('Sign in'));
  assert.ok(!result.includes('Home My Network'));
});

test('extractSnapshotText preserves heading and long content elements', () => {
  const elements = [
    { tag: 'h1', text: 'Announcing our Series B funding round', id: null },
    { tag: 'h2', text: 'Key takeaways from the latest AI safety research paper', id: null },
    { tag: 'span', text: 'We are excited to share that our team has been working on a breakthrough approach to model alignment', id: null },
  ];
  const result = extractSnapshotText(elements);
  assert.ok(result.includes('Series B funding'));
  assert.ok(result.includes('AI safety research'));
  assert.ok(result.includes('breakthrough approach'));
});

// --- Build 4C: Debug inspection ---

test('parseArgs parses --debug flag', () => {
  const args = parseArgs(['--match-url', 'linkedin.com', '--debug']);
  assert.equal(args.debug, true);
  assert.equal(args.matchUrl, 'linkedin.com');
});

test('parseArgs defaults debug to false', () => {
  const args = parseArgs(['--match-url', 'linkedin.com']);
  assert.equal(args.debug, false);
});

test('--debug emits snapshot inspection dump in stdout', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'LinkedIn Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/example' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1', debug: true },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const out = streams.getStdout();
  assert.match(out, /--- Debug: Snapshot Inspection ---/);
  assert.match(out, /--- End Debug: Snapshot Inspection ---/);
  assert.match(out, /"elementCount"/);
  assert.match(out, /"tagDistribution"/);
  assert.match(out, /"filteredSegments"/);
  assert.match(out, /"droppedSegments"/);
});

test('--debug not present omits snapshot inspection dump', async () => {
  const { adapter } = createAdapter();
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const out = streams.getStdout();
  assert.ok(!out.includes('Debug: Snapshot Inspection'));
});

test('buildSnapshotDebugDump classifies elements correctly', () => {
  const elements = [
    { tag: 'h2', text: 'Important post about machine learning models', id: null },
    { tag: 'a', text: 'John Smith', id: null },
    { tag: 'button', text: 'Like', id: null },
    { tag: 'a', text: '3 comments', id: null },
    { tag: 'span', text: 'This is genuinely insightful analysis about the implications of this research for production systems', id: null },
    { tag: 'a', text: 'ab', id: null },  // too short
  ];
  const filtered = extractSnapshotText(elements);
  const raw = extractRawSnapshotText(elements);
  const dump = buildSnapshotDebugDump(elements, filtered, raw, 'short page');

  assert.equal(dump.elementCount, 6);
  assert.equal(dump.tagDistribution['h2'], 1);
  assert.equal(dump.tagDistribution['a'], 3);
  assert.equal(dump.tagDistribution['button'], 1);
  assert.equal(dump.tagDistribution['span'], 1);

  // h2 and span should be kept, a short + button should be dropped
  assert.equal(dump.filteredSegmentCount, 2);
  assert.ok(dump.filteredSegments.some((s) => s.text.includes('machine learning')));
  assert.ok(dump.filteredSegments.some((s) => s.text.includes('genuinely insightful')));

  // Dropped: John Smith (short_anchor), Like (noise_tag), 3 comments (linkedin_noise), ab (too_short)
  assert.equal(dump.droppedSegmentCount, 4);
  assert.ok(dump.droppedSegments.some((s) => s.reason === 'short_anchor'));
  assert.ok(dump.droppedSegments.some((s) => s.reason === 'noise_tag'));
  assert.ok(dump.droppedSegments.some((s) => s.reason === 'linkedin_noise'));
  assert.ok(dump.droppedSegments.some((s) => s.reason === 'too_short'));

  // With short pageText, signal source should be rawSnapshotText
  assert.equal(dump.signalSourceUsed, 'rawSnapshotText');
});

test('buildSnapshotDebugDump handles empty snapshot', () => {
  const dump = buildSnapshotDebugDump([], '', '', 'some page text');
  assert.equal(dump.elementCount, 0);
  assert.deepEqual(dump.tagDistribution, {});
  assert.deepEqual(dump.filteredSegments, []);
  assert.deepEqual(dump.droppedSegments, []);
});

test('extractRawSnapshotText preserves chrome words for signal detection', () => {
  const elements = [
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
    { tag: 'a', text: '3 comments', id: null },
    { tag: 'h2', text: 'Post content here', id: null },
  ];
  const raw = extractRawSnapshotText(elements);
  const filtered = extractSnapshotText(elements);

  // Raw should contain signal words that filtered drops
  assert.ok(raw.includes('Comment'), 'raw should keep Comment');
  assert.ok(raw.includes('Reply'), 'raw should keep Reply');
  assert.ok(raw.includes('3 comments'), 'raw should keep 3 comments');

  // Filtered should drop them
  assert.ok(!filtered.includes('Comment'), 'filtered should drop Comment');
  assert.ok(!filtered.includes('Reply'), 'filtered should drop Reply');
});

test('rawSnapshotText is passed to buildFollowUpBrief for signal extraction', async () => {
  // Simulate a page where pageText is short and snapshot has signal words
  // that would be filtered out by extractSnapshotText but kept by extractRawSnapshotText
  const snapshotWithSignals = [
    { tag: 'h2', text: 'Post content about AI', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
    { tag: 'a', text: 'Add a comment', id: null },
  ];
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/example' } },
    textResult: { status: 200, body: { text: 'short' } },
    snapshotResult: { status: 200, body: { snapshot: snapshotWithSignals } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  // With rawSnapshotText feeding signal extraction, signals should be detected
  assert.equal(brief.followUp.visibleSignals.commentsPresent, true, 'should detect comments via raw snapshot');
  assert.equal(brief.followUp.visibleSignals.replyAffordancesVisible, true, 'should detect reply via raw snapshot');
});

test('extractSnapshotText produces cleaner output for realistic LinkedIn snapshot', () => {
  // Simulate a realistic LinkedIn post page snapshot with mixed chrome and content
  const elements = [
    { tag: 'a', text: 'Home', id: null },
    { tag: 'a', text: 'My Network', id: null },
    { tag: 'a', text: 'Jobs', id: null },
    { tag: 'a', text: 'Messaging', id: null },
    { tag: 'a', text: 'Notifications', id: null },
    { tag: 'button', text: 'Post', id: null },
    { tag: 'a', text: 'Jane Doe', id: null },
    { tag: 'span', text: 'Senior Product Manager at TechCorp', id: null },
    { tag: 'h2', text: 'Thrilled to share our latest research on responsible AI deployment in production systems', id: null },
    { tag: 'span', text: 'Our team spent six months building a framework that allows enterprises to monitor model behavior in real-time', id: null },
    { tag: 'button', text: 'Like', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Repost', id: null },
    { tag: 'button', text: 'Send', id: null },
    { tag: 'a', text: '42 reactions', id: null },
    { tag: 'a', text: '8 comments', id: null },
    { tag: 'a', text: 'People also viewed', id: null },
    { tag: 'a', text: 'Add to your feed', id: null },
    { tag: 'a', text: 'LinkedIn News', id: null },
  ];
  const result = extractSnapshotText(elements);

  // Content should be present
  assert.ok(result.includes('responsible AI deployment'), 'should keep post heading');
  assert.ok(result.includes('monitor model behavior'), 'should keep post body');

  // Chrome should be absent
  assert.ok(!result.includes('Home'), 'should filter nav: Home');
  assert.ok(!result.includes('My Network'), 'should filter nav: My Network');
  assert.ok(!result.includes('Jane Doe'), 'should filter short anchor: author name');
  assert.ok(!result.includes('42 reactions'), 'should filter count pattern');
  assert.ok(!result.includes('8 comments'), 'should filter count pattern');
  assert.ok(!result.includes('People also viewed'), 'should filter sidebar noise');
  assert.ok(!result.includes('LinkedIn News'), 'should filter sidebar noise');
});

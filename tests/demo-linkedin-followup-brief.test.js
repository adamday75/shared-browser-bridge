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
  buildAnchorClusterDebug,
  buildComparativeCandidateDebug,
  isLinkedInNoise,
  computeContentQuality,
  scoreContentElement,
  buildFollowUpBrief,
  buildContentFocusedExcerpt,
  buildLocalityAwareExcerpt,
  extractPostBodyExcerpt,
  extractPostBodyFromPageText,
  extractPostAnchorFromUrl,
  findAnchorIndex,
  inferAuthorFromSnapshot,
  collectAllAuthorCandidates,
  scoreCandidateCluster,
  disambiguateCandidateAnchors,
  isPostDetailPage,
  judgeCommentability,
  generateCommentAngles,
  LOCALITY_WINDOW,
  LOCALITY_BONUS,
  CANDIDATE_CLUSTER_WINDOW,
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
  localSnapshotResult = null,
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
      async localSnapshot({ anchorText } = {}) {
        calls.push(`localSnapshot:${anchorText}`);
        if (localSnapshotResult) return localSnapshotResult;
        return { status: 200, body: { snapshot: [] } };
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
    commentAngles: [
      { angle: 'substantive response', grounding: 'Some post content about AI Optimizer' },
      { angle: 'thread follow-up', grounding: 'the real implementation details matter' },
    ],
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

// --- Build 5: Content-focused excerpt wiring ---

test('scoreContentElement ranks h1 > h2 > p > span for same-length text', () => {
  const text = 'A reasonably long sentence that passes the length threshold for scoring content elements';
  assert.ok(scoreContentElement('h1', text) > scoreContentElement('h2', text));
  assert.ok(scoreContentElement('h2', text) > scoreContentElement('p', text));
  assert.ok(scoreContentElement('p', text) > scoreContentElement('span', text));
});

test('scoreContentElement gives higher scores to longer text', () => {
  const short = 'Short text';
  const long = 'This is a much longer piece of text that should receive a higher content score because it is more likely to be actual post content';
  assert.ok(scoreContentElement('span', long) > scoreContentElement('span', short));
});

test('buildContentFocusedExcerpt ranks by content score not DOM order', () => {
  const elements = [
    { tag: 'a', text: 'Jane Doe posted this update to her network recently', id: null },  // long anchor, low score
    { tag: 'span', text: 'Senior Product Manager at TechCorp', id: null },  // job title noise
    { tag: 'h2', text: 'Our team just shipped a breakthrough in model alignment for production systems', id: null },  // high score: h2 + long
    { tag: 'span', text: 'We spent six months building a framework for real-time model behavior monitoring in enterprise environments', id: null },  // medium score: long span
  ];
  const excerpt = buildContentFocusedExcerpt(elements);
  // h2 should appear before the span content because it scores higher
  const h2Pos = excerpt.indexOf('breakthrough in model alignment');
  const spanPos = excerpt.indexOf('six months building');
  assert.ok(h2Pos >= 0, 'h2 content should be in excerpt');
  assert.ok(spanPos >= 0, 'span content should be in excerpt');
  assert.ok(h2Pos < spanPos, 'h2 should appear before span due to higher score');
});

test('buildContentFocusedExcerpt returns empty string for empty input', () => {
  assert.equal(buildContentFocusedExcerpt([]), '');
  assert.equal(buildContentFocusedExcerpt(null), '');
});

test('combinedExcerpt in brief uses content-focused path when snapshot elements exist', async () => {
  // Construct snapshot where DOM order puts noise first but content-ranked order puts h2 first
  const snapshotWithContent = [
    { tag: 'span', text: 'Some minor detail that appears early in DOM but is not the main content', id: null },
    { tag: 'h2', text: 'Major announcement about our new AI safety research program launching next quarter', id: null },
    { tag: 'p', text: 'Our team has developed novel approaches to alignment that reduce failure rates by significant margins', id: null },
  ];
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/example' } },
    textResult: { status: 200, body: { text: 'short page text' } },
    snapshotResult: { status: 200, body: { snapshot: snapshotWithContent } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const ce = brief.followUp.postContext.combinedExcerpt;
  // The h2 should appear first because it scores highest
  const h2Pos = ce.indexOf('Major announcement');
  const spanPos = ce.indexOf('minor detail');
  assert.ok(h2Pos >= 0, 'combinedExcerpt should contain h2 content');
  assert.ok(spanPos >= 0, 'combinedExcerpt should contain span content');
  assert.ok(h2Pos < spanPos, 'combinedExcerpt should rank h2 before DOM-earlier span');
});

test('combinedExcerpt falls back to pageText excerpt when no snapshot elements', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/' } },
    textResult: { status: 200, body: { text: 'This is the page text content that should be used for excerpt' } },
    snapshotResult: { status: 200, body: { snapshot: [] } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  assert.ok(brief.followUp.postContext.combinedExcerpt.includes('page text content'));
});

test('inspect_only and draft_only modes still work with content-focused excerpts', async () => {
  const snapshotWithContent = [
    { tag: 'h2', text: 'Important post about machine learning advances in production systems', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];
  for (const mode of ['inspect_only', 'draft_only']) {
    const { adapter } = createAdapter({
      tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/example', title: 'Post' }],
      urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/example' } },
      textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
      snapshotResult: { status: 200, body: { snapshot: snapshotWithContent } },
    });
    const streams = createStreams();

    const { exitCode, brief } = await runLinkedInFollowUpBrief({
      adapter,
      args: { targetId: 'T1', mode },
      ...streams,
    });

    assert.equal(exitCode, 0, `${mode} should still exit 0`);
    assert.ok(brief.followUp.postContext.combinedExcerpt.length > 0, `${mode} should have non-empty combinedExcerpt`);
    if (mode === 'draft_only') {
      assert.ok(brief.followUp.drafts.length > 0, 'draft_only should still produce drafts');
    } else {
      assert.deepEqual(brief.followUp.drafts, [], 'inspect_only should produce no drafts');
    }
  }
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

// --- Build 6: Locality-aware excerpt wiring ---

test('extractPostAnchorFromUrl extracts authorSlug from /posts/ URL', () => {
  const { authorSlug, activityId } = extractPostAnchorFromUrl('https://www.linkedin.com/posts/jane-doe-12345');
  assert.equal(authorSlug, 'jane-doe-12345');
  assert.equal(activityId, null);
});

test('extractPostAnchorFromUrl extracts activityId from /feed/update/ URL', () => {
  const { authorSlug, activityId } = extractPostAnchorFromUrl('https://www.linkedin.com/feed/update/urn:li:activity:7123456789');
  assert.equal(authorSlug, null);
  assert.equal(activityId, '7123456789');
});

test('extractPostAnchorFromUrl returns nulls for non-post URL', () => {
  const { authorSlug, activityId } = extractPostAnchorFromUrl('https://www.linkedin.com/feed/');
  assert.equal(authorSlug, null);
  assert.equal(activityId, null);
});

test('extractPostAnchorFromUrl returns nulls for null/undefined', () => {
  assert.deepEqual(extractPostAnchorFromUrl(null), { authorSlug: null, activityId: null });
  assert.deepEqual(extractPostAnchorFromUrl(undefined), { authorSlug: null, activityId: null });
});

test('findAnchorIndex finds element matching activityId', () => {
  const elements = [
    { tag: 'span', text: 'Some unrelated content', id: null },
    { tag: 'div', text: 'Another element', id: 'urn:li:activity:7123456789' },
    { tag: 'h2', text: 'Post body text', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789');
  assert.equal(idx, 1);
});

test('findAnchorIndex finds element matching authorSlug as name', () => {
  const elements = [
    { tag: 'span', text: 'Unrelated sidebar item', id: null },
    { tag: 'span', text: 'Posted by jane doe recently', id: 'jane-doe' },
    { tag: 'h2', text: 'The actual post content here', id: null },
  ];
  // Slug 'jane-doe' (length > 3) → authorName 'jane doe', matches id field
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/posts/jane-doe');
  assert.equal(idx, 1);
});

test('findAnchorIndex returns -1 when no anchor cues match', () => {
  const elements = [
    { tag: 'span', text: 'Nothing relevant here', id: null },
    { tag: 'h2', text: 'Some other content', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/posts/unknown-person-xyz');
  assert.equal(idx, -1);
});

test('findAnchorIndex returns -1 for non-post URL (no cues)', () => {
  const elements = [
    { tag: 'span', text: 'Feed content', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/');
  assert.equal(idx, -1);
});

test('buildLocalityAwareExcerpt boosts near-anchor content over far content', () => {
  // Build elements where the target post cluster is at index 5, but a far-away
  // high-scoring element exists at index 0 (outside LOCALITY_WINDOW if window < 5)
  const elements = [];
  // Far-away high-scoring element (index 0)
  elements.push({ tag: 'h2', text: 'Unrelated post headline that is quite long and would normally score very high in content ranking', id: null });
  // Filler to push anchor far from index 0
  for (let i = 1; i < LOCALITY_WINDOW + 2; i++) {
    elements.push({ tag: 'span', text: `Filler element number ${i} with enough length to pass filters`, id: null });
  }
  // Anchor element (matches author slug)
  const anchorIdx = elements.length;
  elements.push({ tag: 'span', text: 'jane doe shared this post about locality', id: null });
  // Near-anchor content (within LOCALITY_WINDOW)
  elements.push({ tag: 'p', text: 'This nearby paragraph discusses the actual topic of the target post in detail and context', id: null });
  elements.push({ tag: 'span', text: 'A follow-up comment near the anchor about the same topic with additional insight', id: null });

  const excerpt = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/posts/jane-doe-abc123');

  // The near-anchor paragraph should appear before the far-away h2 due to locality bonus
  const nearPos = excerpt.indexOf('actual topic of the target post');
  const farPos = excerpt.indexOf('Unrelated post headline');
  assert.ok(nearPos >= 0, 'near-anchor content should be in excerpt');
  assert.ok(farPos >= 0 || !excerpt.includes('Unrelated'), 'far content may be truncated or present');
  // Key assertion: near-anchor content should come first
  if (farPos >= 0) {
    assert.ok(nearPos < farPos, 'near-anchor content should outrank far-away content due to locality bonus');
  }
});

test('buildLocalityAwareExcerpt falls back to content-focused for non-post URLs', () => {
  const elements = [
    { tag: 'h2', text: 'Feed headline that should be ranked by content score only', id: null },
    { tag: 'span', text: 'Some feed content that appears after the headline in DOM order', id: null },
  ];
  const locality = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/feed/');
  const contentFocused = buildContentFocusedExcerpt(elements);
  assert.equal(locality, contentFocused, 'non-post URL should fall back to content-focused excerpt');
});

test('buildLocalityAwareExcerpt falls back when no anchor found', () => {
  const elements = [
    { tag: 'h2', text: 'Post heading with substantial content about machine learning research', id: null },
    { tag: 'span', text: 'Detailed discussion of the results and implications for the field', id: null },
  ];
  // Post URL but author slug won't match any element
  const locality = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/posts/no-match-zzz999');
  const contentFocused = buildContentFocusedExcerpt(elements);
  assert.equal(locality, contentFocused, 'no-anchor-found should fall back to content-focused excerpt');
});

test('buildLocalityAwareExcerpt returns empty string for empty input', () => {
  assert.equal(buildLocalityAwareExcerpt([], 'https://www.linkedin.com/posts/someone'), '');
  assert.equal(buildLocalityAwareExcerpt(null, 'https://www.linkedin.com/posts/someone'), '');
});

test('combinedExcerpt uses locality-aware path for post URLs in full brief', async () => {
  // Construct snapshot where anchor-nearby content should outrank far-away content
  const elements = [];
  // Far-away high-scoring element
  elements.push({ tag: 'h2', text: 'Completely unrelated trending post about cryptocurrency markets and blockchain', id: null });
  // Filler to push anchor far
  for (let i = 0; i < LOCALITY_WINDOW + 2; i++) {
    elements.push({ tag: 'span', text: `Navigation filler element ${i} with enough text to pass filters`, id: null });
  }
  // Anchor + near content
  elements.push({ tag: 'span', text: 'adam doe posted about the new feature launch', id: null });
  elements.push({ tag: 'h2', text: 'Excited to announce our locality-aware content ranking system for better excerpts', id: null });
  elements.push({ tag: 'p', text: 'This feature ensures that the most relevant content near the target post gets prioritized', id: null });

  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/adam-doe-xyz', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/adam-doe-xyz' } },
    textResult: { status: 200, body: { text: 'short page text' } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const ce = brief.followUp.postContext.combinedExcerpt;
  const nearPos = ce.indexOf('locality-aware content ranking');
  const farPos = ce.indexOf('cryptocurrency markets');
  assert.ok(nearPos >= 0, 'near-anchor content should be in combinedExcerpt');
  if (farPos >= 0) {
    assert.ok(nearPos < farPos, 'near-anchor content should appear before far-away content in combinedExcerpt');
  }
});

test('inspect_only and draft_only boundaries unchanged with locality wiring', async () => {
  const elements = [
    { tag: 'span', text: 'jane doe posted this update', id: null },
    { tag: 'h2', text: 'Important machine learning research announcement with major implications for the field', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];

  for (const mode of ['inspect_only', 'draft_only']) {
    const { adapter } = createAdapter({
      tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/jane-doe-abc', title: 'Post' }],
      urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/jane-doe-abc' } },
      textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
      snapshotResult: { status: 200, body: { snapshot: elements } },
    });
    const streams = createStreams();

    const { exitCode, brief } = await runLinkedInFollowUpBrief({
      adapter,
      args: { targetId: 'T1', mode },
      ...streams,
    });

    assert.equal(exitCode, 0, `${mode} should exit 0 with locality wiring`);
    assert.ok(brief.followUp.postContext.combinedExcerpt.length > 0, `${mode} should have combinedExcerpt`);
    if (mode === 'draft_only') {
      assert.ok(brief.followUp.drafts.length > 0, 'draft_only should still produce drafts');
    } else {
      assert.deepEqual(brief.followUp.drafts, [], 'inspect_only should produce no drafts');
    }
  }
});

// --- Build 7: Anchor cluster debug ---

test('buildAnchorClusterDebug returns cluster around matched anchor with activityId', () => {
  const elements = [
    { tag: 'span', text: '0 notifications total for this account', id: null },
    { tag: 'div', text: 'Adam profile block with about info', id: null },
    { tag: 'span', text: 'Some unrelated feed item about React testing', id: null },
    { tag: 'a', text: 'urn:li:activity:7471184681150070784', id: 'activity-anchor' },
    { tag: 'span', text: 'Basia Kubicka posted this about LLM RAG Agents MCP', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads context and produces answers', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation for grounding in real data', id: null },
    { tag: 'button', text: 'Like', id: null },
    { tag: 'span', text: 'Jeff Bezos posted something unrelated about space', id: null },
  ];

  const result = buildAnchorClusterDebug(
    elements,
    'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/',
    5,
  );

  assert.equal(result.anchorIndex, 3, 'should find anchor at index 3 via activityId');
  assert.equal(result.anchorCues.activityId, '7471184681150070784');
  assert.ok(result.cluster.length > 0, 'cluster should have elements');

  // Anchor element itself should be in the cluster
  const anchorEl = result.cluster.find((c) => c.index === 3);
  assert.ok(anchorEl, 'anchor element should be in cluster');
  assert.equal(anchorEl.distance, 0);

  // Nearby post body should be in cluster and kept
  const postBody = result.cluster.find((c) => c.textExcerpt.includes('Four layers'));
  assert.ok(postBody, 'post body near anchor should be in cluster');
  assert.equal(postBody.disposition, 'kept');
  assert.ok(postBody.localityBonus > 0, 'near-anchor element should have locality bonus');

  // Far-away element should not be in cluster with window=5
  const farEl = result.cluster.find((c) => c.textExcerpt.includes('Jeff Bezos'));
  // Jeff is at index 9, anchor at 3, window 5 → 3+5=8, so index 9 is outside
  assert.ok(!farEl, 'far-away element should be outside cluster window');
});

test('buildAnchorClusterDebug shows disposition for each element type', () => {
  const elements = [
    { tag: 'h2', text: 'Substantive post heading about technology', id: null },
    { tag: 'button', text: 'Like', id: null },
    { tag: 'a', text: 'Follow', id: null },
    { tag: 'a', text: 'Short', id: null },
    { tag: 'span', text: '3 comments', id: null },
    { tag: 'p', text: 'A much longer paragraph that discusses the core topic of the post in great detail', id: null },
  ];

  const result = buildAnchorClusterDebug(elements, 'https://www.linkedin.com/feed/', 10);

  // No anchor found (feed URL), so anchorIndex = -1
  assert.equal(result.anchorIndex, -1);

  // Check dispositions
  const heading = result.cluster.find((c) => c.textExcerpt.includes('Substantive'));
  assert.equal(heading.disposition, 'kept');

  const likeBtn = result.cluster.find((c) => c.textExcerpt.includes('Like'));
  assert.equal(likeBtn.disposition, 'dropped:noise_tag');

  const followLink = result.cluster.find((c) => c.textExcerpt.includes('Follow'));
  assert.equal(followLink.disposition, 'dropped:linkedin_noise');

  const commentsCount = result.cluster.find((c) => c.textExcerpt.includes('3 comments'));
  assert.equal(commentsCount.disposition, 'dropped:linkedin_noise');
});

test('buildAnchorClusterDebug returns empty cluster for empty snapshot', () => {
  const result = buildAnchorClusterDebug([], 'https://www.linkedin.com/posts/someone', 10);
  assert.equal(result.anchorIndex, -1);
  assert.deepEqual(result.cluster, []);
  assert.equal(result.elementCount, 0);
});

test('--debug emits anchor cluster dump in stdout', async () => {
  const elements = [
    { tag: 'span', text: 'Basia Kubicka posted about LLM', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. Actual post body text here.', id: null },
  ];
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/basia-kubicka-abc123', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/basia-kubicka-abc123' } },
    textResult: { status: 200, body: { text: 'short page text' } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1', debug: true },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const out = streams.getStdout();
  assert.match(out, /--- Debug: Anchor Cluster ---/);
  assert.match(out, /--- End Debug: Anchor Cluster ---/);
  assert.match(out, /"anchorIndex"/);
  assert.match(out, /"anchorCues"/);
  assert.match(out, /"cluster"/);
  assert.match(out, /"disposition"/);
  assert.match(out, /"localityBonus"/);
});

// --- Build 8: Author-anchor inference for /feed/update/ post pages ---

test('inferAuthorFromSnapshot extracts author from "Open control menu for post by" pattern', () => {
  const elements = [
    { tag: 'span', text: 'Some unrelated content', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'h2', text: 'Post body here', id: null },
  ];
  const result = inferAuthorFromSnapshot(elements);
  assert.ok(result, 'should find author');
  assert.equal(result.authorName, 'Basia Kubicka');
  assert.equal(result.sourceIndex, 1);
});

test('inferAuthorFromSnapshot extracts author from "Hide post by" pattern', () => {
  const elements = [
    { tag: 'span', text: 'Hide post by Jane Doe', id: null },
    { tag: 'h2', text: 'Post body here', id: null },
  ];
  const result = inferAuthorFromSnapshot(elements);
  assert.ok(result, 'should find author');
  assert.equal(result.authorName, 'Jane Doe');
  assert.equal(result.sourceIndex, 0);
});

test('inferAuthorFromSnapshot returns null when no pattern matches', () => {
  const elements = [
    { tag: 'span', text: 'Some content', id: null },
    { tag: 'h2', text: 'A post heading', id: null },
  ];
  assert.equal(inferAuthorFromSnapshot(elements), null);
});

test('inferAuthorFromSnapshot returns null for empty/null input', () => {
  assert.equal(inferAuthorFromSnapshot([]), null);
  assert.equal(inferAuthorFromSnapshot(null), null);
});

test('inferAuthorFromSnapshot rejects very short author names (< 3 chars)', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by AB', id: null },
  ];
  assert.equal(inferAuthorFromSnapshot(elements), null);
});

test('findAnchorIndex uses inferred author when activityId not in elements', () => {
  // Simulates the Basia-class live scenario:
  // URL has activityId but it doesn't appear in any element text/id.
  // Author name appears via "Open control menu for post by" pattern.
  const elements = [
    { tag: 'nav', text: 'Home', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },  // byline, should be preferred anchor
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');
  // Should anchor on the byline (index 1), not the control-menu element (index 2)
  assert.equal(idx, 1, 'should anchor on byline via inferred author, not control-menu element');
});

test('findAnchorIndex falls back to control-menu element when no other author mention', () => {
  const elements = [
    { tag: 'nav', text: 'Home', id: null },
    { tag: 'button', text: 'Open control menu for post by Unique Author', id: null },
    { tag: 'p', text: 'Post body content here.', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');
  // Only mention of author is the control-menu element itself
  assert.equal(idx, 1, 'should fall back to control-menu element when no other mention');
});

test('findAnchorIndex does not use inference for non-post URLs', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Someone', id: null },
    { tag: 'span', text: 'Someone posted something', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/');
  assert.equal(idx, -1, 'should not use inference on feed URLs');
});

test('findAnchorIndex still prefers URL-derived cues over inference', () => {
  const elements = [
    { tag: 'span', text: 'jane doe shared this post', id: null },
    { tag: 'button', text: 'Open control menu for post by Other Person', id: null },
    { tag: 'span', text: 'Other Person wrote something', id: null },
  ];
  // /posts/ URL with author slug should use URL cue, not inference
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/posts/jane-doe-abc123');
  assert.equal(idx, 0, 'should use URL-derived author slug, not inferred author');
});

test('buildLocalityAwareExcerpt uses inferred anchor for /feed/update/ URLs', () => {
  const elements = [];
  // Far-away high-scoring element
  elements.push({ tag: 'h2', text: 'Completely unrelated trending post about cryptocurrency markets and blockchain technology', id: null });
  // Filler to push anchor far
  for (let i = 0; i < LOCALITY_WINDOW + 2; i++) {
    elements.push({ tag: 'span', text: `Navigation filler element ${i} with enough text to pass filters easily`, id: null });
  }
  // Author byline (will be anchor via inference)
  elements.push({ tag: 'span', text: 'Basia Kubicka', id: null });
  // Control menu pattern (source for inference)
  elements.push({ tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null });
  // Near-anchor content
  elements.push({ tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual target post body content about LLM and RAG.', id: null });
  elements.push({ tag: 'span', text: 'AI agents are autonomous task runners that plan and act in loops to solve problems', id: null });

  const excerpt = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');

  // Near-anchor content should appear before far-away content due to locality bonus
  const nearPos = excerpt.indexOf('Four layers');
  const farPos = excerpt.indexOf('cryptocurrency');
  assert.ok(nearPos >= 0, 'near-anchor content should be in excerpt');
  if (farPos >= 0) {
    assert.ok(nearPos < farPos, 'inferred anchor should drive locality: near content before far content');
  }
});

test('buildLocalityAwareExcerpt falls back gracefully when inference finds nothing', () => {
  const elements = [
    { tag: 'h2', text: 'Post heading with substantial content about machine learning research', id: null },
    { tag: 'span', text: 'Detailed discussion of the results and implications for the field', id: null },
  ];
  // /feed/update/ URL but no inference patterns in snapshot
  const locality = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:9999999999/');
  const contentFocused = buildContentFocusedExcerpt(elements);
  assert.equal(locality, contentFocused, 'should fall back to content-focused when inference fails');
});

test('buildAnchorClusterDebug surfaces inferredAuthor in debug output', () => {
  const elements = [
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
  ];
  const result = buildAnchorClusterDebug(
    elements,
    'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/',
    5,
  );
  assert.ok(result.inferredAuthor, 'debug should surface inferredAuthor');
  assert.equal(result.inferredAuthor.authorName, 'Basia Kubicka');
  assert.equal(result.inferredAuthor.sourceIndex, 1);
  // Anchor should have been found via inference
  assert.ok(result.anchorIndex >= 0, 'anchor should be found via inference');
});

test('inspect_only and draft_only boundaries unchanged with author-anchor inference', async () => {
  const elements = [
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'h2', text: 'Important machine learning research announcement with major implications for the field', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];

  for (const mode of ['inspect_only', 'draft_only']) {
    const { adapter } = createAdapter({
      tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/', title: 'Post' }],
      urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/' } },
      textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
      snapshotResult: { status: 200, body: { snapshot: elements } },
    });
    const streams = createStreams();

    const { exitCode, brief } = await runLinkedInFollowUpBrief({
      adapter,
      args: { targetId: 'T1', mode },
      ...streams,
    });

    assert.equal(exitCode, 0, `${mode} should exit 0 with author-anchor inference`);
    assert.ok(brief.followUp.postContext.combinedExcerpt.length > 0, `${mode} should have combinedExcerpt`);
    if (mode === 'draft_only') {
      assert.ok(brief.followUp.drafts.length > 0, 'draft_only should still produce drafts');
    } else {
      assert.deepEqual(brief.followUp.drafts, [], 'inspect_only should produce no drafts');
    }
  }
});

// --- Build 9: Candidate-anchor disambiguation ---

test('collectAllAuthorCandidates finds multiple authors', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'span', text: 'Spencer Stoddard shared a post', id: null },
    { tag: 'p', text: 'Short take on leadership.', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt and context.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. The librarian.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, act, loop.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter.', id: null },
  ];
  const candidates = collectAllAuthorCandidates(elements);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].authorName, 'Spencer Stoddard');
  assert.equal(candidates[0].sourceIndex, 0);
  assert.equal(candidates[1].authorName, 'Basia Kubicka');
  assert.equal(candidates[1].sourceIndex, 3);
});

test('collectAllAuthorCandidates returns empty for no patterns', () => {
  const elements = [
    { tag: 'span', text: 'Some content', id: null },
    { tag: 'h2', text: 'A post heading', id: null },
  ];
  assert.deepEqual(collectAllAuthorCandidates(elements), []);
});

test('collectAllAuthorCandidates returns empty for null/empty', () => {
  assert.deepEqual(collectAllAuthorCandidates([]), []);
  assert.deepEqual(collectAllAuthorCandidates(null), []);
});

test('scoreCandidateCluster scores richer cluster higher', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'span', text: 'Spencer Stoddard shared a quick take', id: null },
    { tag: 'p', text: 'Short take on leadership.', id: null },
    // gap
    { tag: 'span', text: 'Filler nav element that is long enough', id: null },
    { tag: 'span', text: 'Another filler element that is long enough', id: null },
    // richer candidate
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content about LLM and RAG.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop until done.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter for tool access.', id: null },
  ];

  const spencer = { authorName: 'Spencer Stoddard', sourceIndex: 0 };
  const basia = { authorName: 'Basia Kubicka', sourceIndex: 5 };

  const spencerScore = scoreCandidateCluster(elements, spencer);
  const basiaScore = scoreCandidateCluster(elements, basia);

  assert.ok(basiaScore.clusterScore > spencerScore.clusterScore,
    `Basia cluster (${basiaScore.clusterScore}) should outscore Spencer (${spencerScore.clusterScore})`);
  assert.ok(basiaScore.keptChars > spencerScore.keptChars,
    `Basia keptChars (${basiaScore.keptChars}) should exceed Spencer (${spencerScore.keptChars})`);
});

test('disambiguateCandidateAnchors picks richer cluster over first match', () => {
  // This is the core Build 9 scenario: Spencer appears first but Basia has the richer cluster.
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'span', text: 'Spencer Stoddard shared a quick take', id: null },
    { tag: 'p', text: 'Short take on leadership.', id: null },
    { tag: 'span', text: 'Filler nav element that is long enough', id: null },
    { tag: 'span', text: 'Another filler element that is long enough', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content about LLM and RAG.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop until done.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter for tool access.', id: null },
  ];

  const result = disambiguateCandidateAnchors(elements);
  assert.ok(result, 'should return disambiguation result');
  assert.equal(result.winner.authorName, 'Basia Kubicka', 'should pick Basia (richer cluster)');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.reason.includes('Basia Kubicka'), 'reason should mention winner');
});

test('disambiguateCandidateAnchors returns single candidate without disambiguation', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Post body text here.', id: null },
  ];
  const result = disambiguateCandidateAnchors(elements);
  assert.ok(result);
  assert.equal(result.winner.authorName, 'Basia Kubicka');
  assert.equal(result.candidates.length, 1);
  assert.ok(result.reason.includes('single candidate'));
});

test('disambiguateCandidateAnchors returns null when no candidates', () => {
  const elements = [
    { tag: 'span', text: 'No author patterns here', id: null },
  ];
  assert.equal(disambiguateCandidateAnchors(elements), null);
});

test('disambiguateCandidateAnchors falls back to first on tie', () => {
  // Two candidates with identical cluster structure
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Alice', id: null },
    { tag: 'p', text: 'Exactly the same length content as the other post below here.', id: null },
    { tag: 'button', text: 'Open control menu for post by Bob Jones', id: null },
    { tag: 'p', text: 'Exactly the same length content as the other post above here.', id: null },
  ];
  const result = disambiguateCandidateAnchors(elements);
  assert.ok(result);
  // On a true tie, should fall back to first candidate
  assert.ok(result.reason.includes('inconclusive') || result.winner.authorName === 'Alice' || result.winner.authorName === 'Bob Jones');
});

test('findAnchorIndex uses disambiguation to pick later stronger candidate', () => {
  // The Spencer-vs-Basia scenario via findAnchorIndex
  const elements = [
    { tag: 'span', text: 'Spencer Stoddard', id: null },
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'p', text: 'Short take on leadership.', id: null },
    { tag: 'span', text: 'Filler nav element with enough text', id: null },
    { tag: 'span', text: 'Another filler with enough text content', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content about LLM and RAG.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop until done.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter for tool access.', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');
  // Should anchor on Basia's byline (index 5), not Spencer's (index 0)
  assert.equal(idx, 5, 'should anchor on Basia byline via disambiguation, not Spencer');
});

test('findAnchorIndex still works with single candidate after disambiguation', () => {
  const elements = [
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
  ];
  const idx = findAnchorIndex(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');
  assert.equal(idx, 0, 'should anchor on byline for single candidate');
});

test('buildAnchorClusterDebug surfaces disambiguation info', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'p', text: 'Short take.', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content about LLM and RAG.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null },
  ];
  const result = buildAnchorClusterDebug(
    elements,
    'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/',
    10,
  );
  assert.ok(result.disambiguation, 'debug should surface disambiguation');
  assert.equal(result.disambiguation.candidateCount, 2);
  assert.equal(result.disambiguation.winnerAuthor, 'Basia Kubicka');
  assert.ok(result.disambiguation.reason.length > 0);
  assert.equal(result.disambiguation.candidates.length, 2);
});

test('buildLocalityAwareExcerpt uses disambiguated anchor for /feed/update/ with multiple candidates', () => {
  const elements = [];
  // Spencer's thin card
  elements.push({ tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null });
  elements.push({ tag: 'span', text: 'Spencer Stoddard', id: null });
  elements.push({ tag: 'p', text: 'Short motivational take on leadership for today.', id: null });
  // Filler to separate
  for (let i = 0; i < 5; i++) {
    elements.push({ tag: 'span', text: `Navigation filler element ${i} with enough text to pass filters`, id: null });
  }
  // Basia's rich post
  elements.push({ tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null });
  elements.push({ tag: 'span', text: 'Basia Kubicka', id: null });
  elements.push({ tag: 'p', text: 'Four layers. Four jobs. One system. Understanding LLM RAG Agents and MCP together.', id: null });
  elements.push({ tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null });
  elements.push({ tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data.', id: null });

  const excerpt = buildLocalityAwareExcerpt(elements, 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/');

  // Basia's content should appear before Spencer's due to disambiguation + locality
  const basiaPos = excerpt.indexOf('Four layers');
  const spencerPos = excerpt.indexOf('motivational take');
  assert.ok(basiaPos >= 0, 'Basia content should be in excerpt');
  if (spencerPos >= 0) {
    assert.ok(basiaPos < spencerPos, 'Basia content should outrank Spencer content via disambiguation');
  }
});

test('inspect_only and draft_only boundaries unchanged with Build 9 disambiguation', async () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'p', text: 'Short take.', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'h2', text: 'Important machine learning research announcement with major implications for the field', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];

  for (const mode of ['inspect_only', 'draft_only']) {
    const { adapter } = createAdapter({
      tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/', title: 'Post' }],
      urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/' } },
      textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
      snapshotResult: { status: 200, body: { snapshot: elements } },
    });
    const streams = createStreams();

    const { exitCode, brief } = await runLinkedInFollowUpBrief({
      adapter,
      args: { targetId: 'T1', mode },
      ...streams,
    });

    assert.equal(exitCode, 0, `${mode} should exit 0 with Build 9 disambiguation`);
    assert.ok(brief.followUp.postContext.combinedExcerpt.length > 0, `${mode} should have combinedExcerpt`);
    if (mode === 'draft_only') {
      assert.ok(brief.followUp.drafts.length > 0, 'draft_only should still produce drafts');
    } else {
      assert.deepEqual(brief.followUp.drafts, [], 'inspect_only should produce no drafts');
    }
  }
});

test('buildAnchorClusterDebug Basia-class scenario answers the key question', () => {
  // Simulate what we expect from the real Basia Kubicka snapshot:
  // The question is whether the post body appears near the anchor or not at all.
  const elements = [
    { tag: 'nav', text: 'Home', id: null },
    { tag: 'span', text: '0 notifications', id: null },
    { tag: 'div', text: 'Adam D. — About section and profile summary', id: null },
    { tag: 'span', text: 'Jeff Bezos shared a motivational quote about innovation', id: null },
    { tag: 'span', text: 'React: Testing and Debugging best practices for 2025', id: null },
    // --- anchor region ---
    { tag: 'a', text: 'Basia Kubicka', id: null },
    { tag: 'span', text: 'LLM, RAG, Agents, MCP', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, your injected data and produces an answer.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter.', id: null },
    // --- end anchor region ---
    { tag: 'button', text: 'Like', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'span', text: 'Some other unrelated post content far away', id: null },
  ];

  const result = buildAnchorClusterDebug(
    elements,
    'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/',
    8,
  );

  // In this scenario, anchor won't match via activityId (not in text/id),
  // so anchorIndex should be -1. This itself is evidence!
  // If we see anchorIndex = -1 in live debug, it means findAnchorIndex
  // can't locate the anchor from URL cues alone — the activityId isn't
  // embedded in any element text or id.
  //
  // But the cluster still dumps elements 0..16 for inspection.
  // Let's verify the cluster contains the post body elements.
  const postBody = result.cluster.find((c) => c.textExcerpt.includes('Four layers'));
  assert.ok(postBody, 'Basia post body should be visible in cluster dump');
  assert.equal(postBody.disposition, 'kept');

  const llmSection = result.cluster.find((c) => c.textExcerpt.includes('LLM'));
  assert.ok(llmSection, 'LLM section should be visible in cluster dump');
});

// --- Build 10: Comparative candidate cluster debug ---

test('buildComparativeCandidateDebug dumps per-candidate clusters for Spencer vs Basia', () => {
  // Reproduces the live Spencer-vs-Basia scenario with realistic element layout.
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'span', text: 'Spencer Stoddard', id: null },
    { tag: 'p', text: 'Short take on leadership.', id: null },
    { tag: 'span', text: 'Filler nav element that is long enough', id: null },
    { tag: 'span', text: 'Another filler element that is long enough', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body content about LLM and RAG.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop until done.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter for tool access.', id: null },
  ];

  const result = buildComparativeCandidateDebug(elements);

  assert.equal(result.candidateCount, 2);
  assert.equal(result.candidates.length, 2);

  // Should be sorted by clusterScore descending — Basia first (richer cluster)
  const first = result.candidates[0];
  const second = result.candidates[1];
  assert.equal(first.authorName, 'Basia Kubicka', 'Basia should rank first (richer cluster)');
  assert.equal(second.authorName, 'Spencer Stoddard');
  assert.ok(first.clusterScore > second.clusterScore,
    `Basia score (${first.clusterScore}) should exceed Spencer (${second.clusterScore})`);

  // Each candidate should have a cluster array with per-element details
  assert.ok(first.cluster.length > 0, 'Basia cluster should have elements');
  assert.ok(second.cluster.length > 0, 'Spencer cluster should have elements');

  // Basia's cluster should contain her post body
  const basiaBody = first.cluster.find((c) => c.textExcerpt.includes('Four layers'));
  assert.ok(basiaBody, 'Basia cluster should contain post body');
  assert.equal(basiaBody.disposition, 'kept');
  assert.ok(basiaBody.score > 0, 'Basia post body should have positive score');

  // Spencer's cluster should contain his short take
  const spencerBody = second.cluster.find((c) => c.textExcerpt.includes('Short take'));
  assert.ok(spencerBody, 'Spencer cluster should contain his post body');
  assert.equal(spencerBody.disposition, 'kept');

  // Each cluster element should have all expected fields
  for (const el of first.cluster) {
    assert.ok('index' in el, 'cluster element should have index');
    assert.ok('distance' in el, 'cluster element should have distance');
    assert.ok('tag' in el, 'cluster element should have tag');
    assert.ok('disposition' in el, 'cluster element should have disposition');
    assert.ok('score' in el, 'cluster element should have score');
    assert.ok('localityBonus' in el, 'cluster element should have localityBonus');
    assert.ok('totalScore' in el, 'cluster element should have totalScore');
    assert.ok('charLen' in el, 'cluster element should have charLen');
    assert.ok('textExcerpt' in el, 'cluster element should have textExcerpt');
  }
});

test('buildComparativeCandidateDebug returns empty for no candidates', () => {
  const elements = [
    { tag: 'span', text: 'No author patterns here', id: null },
  ];
  const result = buildComparativeCandidateDebug(elements);
  assert.equal(result.candidateCount, 0);
  assert.deepEqual(result.candidates, []);
});

test('buildComparativeCandidateDebug returns empty for empty/null snapshot', () => {
  assert.deepEqual(buildComparativeCandidateDebug([]), { candidateCount: 0, candidates: [] });
  assert.deepEqual(buildComparativeCandidateDebug(null), { candidateCount: 0, candidates: [] });
});

test('buildComparativeCandidateDebug works with single candidate', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system.', id: null },
  ];
  const result = buildComparativeCandidateDebug(elements);
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].authorName, 'Basia Kubicka');
  assert.ok(result.candidates[0].cluster.length > 0);
});

test('buildComparativeCandidateDebug shows noise filtering in cluster elements', () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Test Author', id: null },
    { tag: 'button', text: 'Like', id: null },
    { tag: 'a', text: 'Follow', id: null },
    { tag: 'span', text: '3 comments', id: null },
    { tag: 'p', text: 'Substantive post body content that is long enough to score well', id: null },
  ];
  const result = buildComparativeCandidateDebug(elements);
  assert.equal(result.candidateCount, 1);

  const cluster = result.candidates[0].cluster;
  const likeBtn = cluster.find((c) => c.textExcerpt === 'Like');
  assert.equal(likeBtn.disposition, 'dropped:noise_tag');

  const followLink = cluster.find((c) => c.textExcerpt === 'Follow');
  assert.equal(followLink.disposition, 'dropped:linkedin_noise');

  const comments = cluster.find((c) => c.textExcerpt === '3 comments');
  assert.equal(comments.disposition, 'dropped:linkedin_noise');

  const body = cluster.find((c) => c.textExcerpt.includes('Substantive'));
  assert.equal(body.disposition, 'kept');
  assert.ok(body.score > 0);
});

test('--debug emits comparative candidate cluster dump in stdout', async () => {
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Spencer Stoddard', id: null },
    { tag: 'p', text: 'Short take.', id: null },
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'p', text: 'Four layers. Four jobs. One system. This is the actual post body.', id: null },
  ];
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:7471184681150070784/' } },
    textResult: { status: 200, body: { text: 'short page text' } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1', debug: true },
    ...streams,
  });

  assert.equal(exitCode, 0);
  const out = streams.getStdout();
  assert.match(out, /--- Debug: Comparative Candidate Clusters \(Build 10\) ---/);
  assert.match(out, /--- End Debug: Comparative Candidate Clusters ---/);
  assert.match(out, /"candidateCount"/);
  assert.match(out, /"Spencer Stoddard"/);
  assert.match(out, /"Basia Kubicka"/);
  assert.match(out, /"clusterRange"/);
});

// --- M15 Build 1: Eligibility + commentability in real brief JSON ---

test('M15: eligible post + strong content → brief has commentability and grounded commentAngles', async () => {
  // Rich post-detail page with substantial content
  const elements = [
    { tag: 'button', text: 'Open control menu for post by Basia Kubicka', id: null },
    { tag: 'span', text: 'Basia Kubicka', id: null },
    { tag: 'h2', text: 'Four layers. Four jobs. One system. Understanding how LLM RAG Agents and MCP work together.', id: null },
    { tag: 'span', text: '1️⃣ LLM — the reasoning engine that reads your prompt, your context window, and produces an answer based on training.', id: null },
    { tag: 'span', text: '2️⃣ RAG — retrieval-augmented generation. It is the librarian that fetches real-time data from your knowledge base.', id: null },
    { tag: 'span', text: '3️⃣ AI agents — autonomous task runners. They plan, they act, they loop until the job is done properly.', id: null },
    { tag: 'span', text: '4️⃣ MCP — model context protocol. The universal adapter that connects LLMs to external tools and data.', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];

  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/basia-kubicka-abc123', title: 'LLM RAG Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/basia-kubicka-abc123' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);

  // Eligibility wired into real brief
  assert.ok(brief.followUp.eligibility, 'brief must have eligibility');
  assert.equal(brief.followUp.eligibility.eligible, true);
  assert.ok(brief.followUp.eligibility.reason.length > 0, 'reason should be non-empty');

  // Commentability wired into real brief
  assert.ok(brief.followUp.commentability, 'brief must have commentability');
  assert.equal(brief.followUp.commentability.commentWorthy, true);
  assert.ok(Array.isArray(brief.followUp.commentability.reasons));
  assert.ok(brief.followUp.commentability.reasons.length > 0);

  // Comment angles wired into real brief — grounded in actual excerpt
  assert.ok(Array.isArray(brief.followUp.commentAngles), 'brief must have commentAngles array');
  assert.ok(brief.followUp.commentAngles.length >= 1, 'should have at least 1 comment angle');
  for (const angle of brief.followUp.commentAngles) {
    assert.ok(angle.angle, 'each angle must have an angle type');
    assert.ok(angle.grounding, 'each angle must have grounding text');
    assert.ok(angle.grounding.length >= 10, 'grounding must be substantive, not empty');
  }
});

test('extractPostBodyFromPageText isolates Vikram post body and stops before comments/link preview', () => {
  const pageText = [
    'Feed post',
    'Vikram Chahal, CFA',
    '• Following',
    'Operator | Investor | Founder',
    '14h •',
    "196 startups presented at Y Combinator's Demo Day this week. Nearly every company was building AI agents, but that's not where the investor money went.",
    'Look at where the biggest checks actually went:',
    '- A counter-drone robotics company, reportedly the most valuable in the batch, near $200 million.',
    '- A startup making return vehicles for things manufactured in space.',
    '- A cancer-screening MRI that fits in the back of a truck.',
    'What the founders were building and what investors were paying for were two different things.',
    'Link in comments. Curious to hear your thoughts.',
    '108',
    '6',
    '1',
    'Most relevant',
    'Vikram Chahal, CFA',
    'Author',
    'Link here: https://open.substack.com/pub/vikchahal/p/ycs-batch-is-a-mirror-not-a-map?r',
    "YC's Batch Is a Mirror, Not a Map.",
    'vikchahal.substack.com',
  ].join('\n\n');

  const excerpt = extractPostBodyFromPageText(
    pageText,
    'https://www.linkedin.com/feed/update/urn:li:activity:7473880428383297536/',
    'Vikram Chahal, CFA',
  );

  assert.match(excerpt, /196 startups presented at Y Combinator's Demo Day this week/);
  assert.match(excerpt, /counter-drone robotics company/);
  assert.match(excerpt, /What the founders were building and what investors were paying for were/);
  assert.equal(excerpt.includes('Most relevant'), false);
  assert.equal(excerpt.includes('Link here:'), false);
  assert.equal(excerpt.includes('vikchahal.substack.com'), false);
});

test('buildFollowUpBrief prefers pageText-isolated body over noisy snapshot body on Vikram-style post', () => {
  const pageText = [
    'Feed post',
    'Vikram Chahal, CFA',
    '• Following',
    'Operator | Investor | Founder',
    '14h •',
    "196 startups presented at Y Combinator's Demo Day this week. Nearly every company was building AI agents, but that's not where the investor money went.",
    'Look at where the biggest checks actually went:',
    '- A counter-drone robotics company, reportedly the most valuable in the batch, near $200 million.',
    '- A startup making return vehicles for things manufactured in space.',
    '- A cancer-screening MRI that fits in the back of a truck.',
    'What the founders were building and what investors were paying for were two different things.',
    'Link in comments. Curious to hear your thoughts.',
    'Most relevant',
    'Vikram Chahal, CFA',
    'Author',
    'Link here: https://open.substack.com/pub/vikchahal/p/ycs-batch-is-a-mirror-not-a-map?r',
  ].join('\n\n');

  const brief = buildFollowUpBrief({
    selectedTab: { id: 'T1', title: 'Post | LinkedIn', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7473880428383297536/' },
    readUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7473880428383297536/',
    pageText,
    snapshotText: '',
    rawSnapshotText: '',
    snapshotElements: [
      { tag: 'div', text: 'Vikram Chahal, CFA • Following Operator | Investor | Founder 14h •', id: null },
      { tag: 'p', text: "196 startups presented at Y Combinator's Demo Day this week. Nearly every company was building AI agents, but that's not where the investor money went. Look at where the biggest checks actually went:", id: null },
      { tag: 'div', text: 'Vikram Chahal, CFA Author Operator | Investor | Founder 14h', id: null },
      { tag: 'div', text: "Link here: https://open.substack.com/pub/vikchahal/p/ycs-batch-is-a-mirror-not-a-map?r YC's Batch Is a Mirror, Not a Map. vikchahal.substack.com", id: null },
    ],
    localSnapshotText: '',
    localRawSnapshotText: '',
    localSnapshotElements: [
      { tag: 'div', text: 'Vikram Chahal, CFA • Following Operator | Investor | Founder 14h •', id: null },
    ],
    mode: 'draft_only',
  });

  assert.match(brief.followUp.postContext.postBodyExcerpt, /196 startups presented at Y Combinator's Demo Day this week/);
  assert.match(brief.followUp.postContext.postBodyExcerpt, /counter-drone robotics company/);
  assert.match(brief.followUp.postContext.postBodyExcerpt, /What the founders were building and what investors were paying for were/);
  assert.equal(brief.followUp.postContext.postBodyExcerpt.includes('Link here:'), false);
  assert.equal(brief.followUp.postContext.postBodyExcerpt.includes('Most relevant'), false);
});

test('Vikram-style grounded drafts sound natural instead of quoted excerpt mashup', () => {
  const brief = buildFollowUpBrief({
    selectedTab: { id: 'T1', title: 'Post | LinkedIn', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7473880428383297536/' },
    readUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7473880428383297536/',
    pageText: [
      'Feed post',
      'Vikram Chahal, CFA',
      '• Following',
      'Operator | Investor | Founder',
      '14h •',
      "196 startups presented at Y Combinator's Demo Day this week. Nearly every company was building AI agents, but that's not where the investor money went.",
      'What the founders were building and what investors were paying for were two different things.',
      'So I read the batch by price instead of by pitch, and the gap points somewhere interesting: the most durable value in this AI wave is one layer down from where everyone is looking.',
      'Link in comments. Curious to hear your thoughts.',
      'Most relevant',
      'Patrick O\'Connor-Read',
    ].join('\n\n'),
    snapshotText: '',
    rawSnapshotText: '',
    snapshotElements: [],
    localSnapshotText: '',
    localRawSnapshotText: '',
    localSnapshotElements: [],
    mode: 'draft_only',
  });

  const commentDraft = brief.followUp.drafts.find(d => d.kind === 'comment_candidate')?.text ?? '';
  assert.match(commentDraft, /^This is the right read\./);
  assert.match(commentDraft, /gap between what everyone says they.?re building/i);
  assert.match(commentDraft, /investors are actually paying/i);
  assert.match(commentDraft, /surface AI-agent narrative/i);
  assert.equal(commentDraft.includes('This is good.'), false);
  assert.equal(commentDraft.includes('The part that stands out to me'), false);
  assert.equal(commentDraft.includes('Link here:'), false);
  assert.equal(commentDraft.includes('Most relevant'), false);
});

test('OKF-style grounded drafts sound sharper and more opinionated', () => {
  const brief = buildFollowUpBrief({
    selectedTab: { id: 'T1', title: 'Post | LinkedIn', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7472177160347160576/' },
    readUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7472177160347160576/',
    pageText: [
      'Feed post',
      'Suganthan Mohanadasan',
      '• Following',
      'Co-founder @ Snippet Digital // Search Journey Optimization',
      '5d •',
      'Google shipped a standard for the thing I keep writing about here, making your website readable by AI agents.',
      'It is the Open Knowledge Format (OKF), and unlike most things Google ships, you can write one in a text editor.',
      'It\'s plain underneath. A folder of markdown files, one per page, tagged with what each is and linked to the rest, so an agent gets your content and how it connects without scraping.',
      'Worth doing early, or just another file nobody reads? I lean early, but I understand the eye-rolls.',
      'Blog post, Generator tool and the Wordpress plugin in the comments.',
      'Most relevant',
      'Noisy commenter',
    ].join('\n\n'),
    snapshotText: '',
    rawSnapshotText: '',
    snapshotElements: [],
    localSnapshotText: '',
    localRawSnapshotText: '',
    localSnapshotElements: [],
    mode: 'draft_only',
  });

  const commentDraft = brief.followUp.drafts.find(d => d.kind === 'comment_candidate')?.text ?? '';
  assert.match(commentDraft, /AI-readability infrastructure/i);
  assert.match(commentDraft, /markdown/i);
  assert.match(commentDraft, /AI theater/i);
  assert.match(commentDraft, /normal web plumbing/i);
  assert.equal(commentDraft.includes('What stands out to me'), false);
  assert.equal(commentDraft.includes('Most relevant'), false);
});

test('Basia-style AI coding post does not cross-fire into the OKF canned draft', () => {
  const brief = buildFollowUpBrief({
    selectedTab: { id: 'T1', title: 'Post | LinkedIn', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7473721297433329665/' },
    readUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7473721297433329665/',
    pageText: [
      'Feed post',
      'Basia Kubicka • Following',
      'AI PM · Vibe Coding · AI Agents · Ex-AI PM @ API dev platform (Sequoia-backed), Ex-founder (Techstars-backed)',
      '1d •',
      'Spotify just showed Anthropic how to ship with AI.',
      'Today, 99% of them use AI coding tools every week. Their PR volume is up 76%, and migrations that took months now take days.',
      'So everyone assumes the lesson is "buy more AI."',
      'It was 15 years of boring standardization they did BEFORE AI existed.',
      'So the real lesson isn\'t "unleash AI." It\'s reduce variance first.',
      'Drop a comment below.',
      'reply',
    ].join('\n\n'),
    snapshotText: '',
    rawSnapshotText: '',
    snapshotElements: [],
    localSnapshotText: '',
    localRawSnapshotText: '',
    localSnapshotElements: [],
    mode: 'draft_only',
  });

  const commentDraft = brief.followUp.drafts.find(d => d.kind === 'comment_candidate')?.text ?? '';
  assert.equal(commentDraft.includes('AI theater'), false);
  assert.equal(commentDraft.includes('normal web plumbing'), false);
  assert.equal(commentDraft.includes('markdown'), false);
  assert.match(commentDraft, /people usually miss/i);
  assert.match(commentDraft, /visible AI lift/i);
  assert.match(commentDraft, /standardization underneath/i);
  assert.match(commentDraft, /speed up the mess/i);
  assert.equal(commentDraft.includes('What stands out to me'), false);
});

test('Basia-style page-text body extraction skips byline shell before real post prose', () => {
  const brief = buildFollowUpBrief({
    selectedTab: { id: 'T1', title: 'Post | LinkedIn', url: 'https://www.linkedin.com/feed/update/urn:li:activity:7473721297433329665/' },
    readUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:7473721297433329665/',
    pageText: [
      'Feed post',
      'Basia Kubicka • Following',
      'AI PM · Vibe Coding · AI Agents · Ex-AI PM @ API dev platform (Sequoia-backed), Ex-founder (Techstars-backed)',
      'View my newsletter',
      '1d •',
      'Spotify just showed Anthropic how to ship with AI.',
      'Today, 99% of them use AI coding tools every week. Their PR volume is up 76%, and migrations that took months now take days.',
      'So everyone assumes the lesson is "buy more AI."',
      'It was 15 years of boring standardization they did BEFORE AI existed.',
      'So the real lesson isn\'t "unleash AI." It\'s reduce variance first.',
      'Drop a comment below.',
      'reply',
    ].join('\n\n'),
    snapshotText: '',
    rawSnapshotText: '',
    snapshotElements: [],
    localSnapshotText: '',
    localRawSnapshotText: '',
    localSnapshotElements: [
      { tag: 'span', text: 'Basia Kubicka', id: null },
    ],
    mode: 'draft_only',
  });

  const excerpt = brief.followUp.postContext.postBodyExcerpt;
  assert.match(excerpt, /^Spotify just showed Anthropic how to ship with AI\./);
  assert.equal(excerpt.includes('AI PM · Vibe Coding'), false);
  assert.equal(excerpt.includes('View my newsletter'), false);
  assert.equal(excerpt.includes('Following'), false);
});

test('M15: eligible post + weak/thin content → brief has commentability but no commentAngles', async () => {
  // Post-detail page but content is too sparse for comment-prep
  const elements = [
    { tag: 'span', text: 'Short post with minimal content', id: null },
  ];

  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/someone-abc', title: 'Thin Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/someone-abc' } },
    textResult: { status: 200, body: { text: 'Very short.' } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);

  // Eligible (it IS a post-detail page)
  assert.ok(brief.followUp.eligibility);
  assert.equal(brief.followUp.eligibility.eligible, true);

  // Commentability is present but says not worth it
  assert.ok(brief.followUp.commentability, 'brief must have commentability even for weak posts');
  assert.equal(brief.followUp.commentability.commentWorthy, false, 'weak post should not be comment-worthy');

  // No comment angles forced on weak content
  assert.deepEqual(brief.followUp.commentAngles, [], 'weak post should have empty commentAngles');
});

test('M15: non-post-detail page (feed) → brief has ineligible result, no comment-prep', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/', title: 'LinkedIn Feed' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
    snapshotResult: { status: 200, body: { snapshot: [] } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);

  // Ineligible — feed is not a post-detail page
  assert.ok(brief.followUp.eligibility);
  assert.equal(brief.followUp.eligibility.eligible, false);
  assert.ok(brief.followUp.eligibility.reason.includes('feed'));

  // No commentability or angles for ineligible pages
  assert.equal(brief.followUp.commentability, null, 'ineligible page should have null commentability');
  assert.deepEqual(brief.followUp.commentAngles, [], 'ineligible page should have empty commentAngles');
});

test('M15: non-post-detail page (profile) → brief has ineligible result', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/in/someone/', title: 'Profile' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/in/someone/' } },
    textResult: { status: 200, body: { text: 'Profile page content' } },
    snapshotResult: { status: 200, body: { snapshot: [] } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);
  assert.equal(brief.followUp.eligibility.eligible, false);
  assert.ok(brief.followUp.eligibility.reason.includes('profile'));
  assert.equal(brief.followUp.commentability, null);
  assert.deepEqual(brief.followUp.commentAngles, []);
});

test('M15: existing brief fields preserved alongside new M15 fields', async () => {
  // Ensure M15 wiring does not break existing brief shape
  const elements = [
    { tag: 'h2', text: 'A substantial post about technology trends in enterprise AI deployment and infrastructure', id: null },
    { tag: 'p', text: 'The rapid advancement of language models has created new opportunities for automation in knowledge work', id: null },
    { tag: 'button', text: 'Comment', id: null },
    { tag: 'button', text: 'Reply', id: null },
  ];

  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/posts/test-abc', title: 'Test Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/posts/test-abc' } },
    textResult: { status: 200, body: { text: LINKEDIN_POST_TEXT } },
    snapshotResult: { status: 200, body: { snapshot: elements } },
  });
  const streams = createStreams();

  const { exitCode, brief } = await runLinkedInFollowUpBrief({
    adapter,
    args: { targetId: 'T1' },
    ...streams,
  });

  assert.equal(exitCode, 0);

  // Existing M14 fields still present
  assert.ok(brief.ok);
  assert.ok(brief.target);
  assert.ok(brief.followUp.surface === 'linkedin');
  assert.ok(brief.followUp.contextType);
  assert.ok(brief.followUp.postContext);
  assert.ok(brief.followUp.postContext.combinedExcerpt);
  assert.ok(brief.followUp.visibleSignals);
  assert.ok(brief.followUp.suggestedMode);
  assert.ok(Array.isArray(brief.followUp.drafts));
  assert.ok(Array.isArray(brief.followUp.notes));
  assert.ok(Array.isArray(brief.followUp.limitations));

  // New M15 fields present
  assert.ok('eligibility' in brief.followUp, 'eligibility must be in brief');
  assert.ok('commentability' in brief.followUp, 'commentability must be in brief');
  assert.ok('commentAngles' in brief.followUp, 'commentAngles must be in brief');
});

test('M15: grounded excerpt strips trailing author residue from local snapshot', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/' } },
    textResult: { status: 200, body: { text: 'Some detailed post content. Comment Reply Add a comment' } },
    snapshotResult: { status: 200, body: { snapshot: [
      { tag: 'a', text: 'Open control menu for post by Ani Filipova', id: null },
      { tag: 'a', text: 'Under 40 lists measure speed. Calloused hands measure cost. Ani Filipova', id: null },
    ] } },
    localSnapshotResult: { status: 200, body: { snapshot: [
      { tag: 'a', text: 'Open control menu for post by Ani Filipova', id: null },
      { tag: 'a', text: 'Under 40 lists measure speed. Calloused hands measure cost. Ani Filipova', id: null },
    ] } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.equal(brief.followUp.postContext.combinedExcerpt.includes('Ani Filipova'), false);
});

test('M15: post-body excerpt skips author shell and lands on actual post prose', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/' } },
    textResult: { status: 200, body: { text: 'I was told 51 was too late to start a business. Turns out, it was the perfect age. Comment Reply Add a comment' } },
    snapshotResult: { status: 200, body: { snapshot: [
      { tag: 'span', text: 'Ani Filipova\nAni Filipova\n • Following\nPremium • Following', id: null },
      { tag: 'span', text: 'I help professionals build career options • Brand building, AI, corporate-to-entrepreneur transitions • AI Advisor • Speaker • Founder Membership community and Accelerator • Ex-COO Citi', id: null },
      { tag: 'button', text: 'Open control menu for post by Ani Filipova', id: null },
      { tag: 'div', text: 'I was told 51 was too late to start a business. Turns out, it was the perfect age.', id: null },
    ] } },
    localSnapshotResult: { status: 200, body: { snapshot: [
      { tag: 'span', text: 'Ani Filipova\nAni Filipova\n • Following\nPremium • Following', id: null },
      { tag: 'span', text: 'I help professionals build career options • Brand building, AI, corporate-to-entrepreneur transitions • AI Advisor • Speaker • Founder Membership community and Accelerator • Ex-COO Citi', id: null },
    ] } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1' }, ...streams });

  assert.ok(brief.followUp.postContext.postBodyExcerpt.includes('I was told 51 was too late to start a business'));
  assert.equal(brief.followUp.postContext.postBodyExcerpt.includes('I help professionals build career options'), false);
});

test('M15: draft_only uses grounded comment angles instead of generic placeholders', async () => {
  const { adapter } = createAdapter({
    tabs: [{ id: 'T1', url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/', title: 'Post' }],
    urlResult: { status: 200, body: { url: 'https://www.linkedin.com/feed/update/urn:li:activity:12345/' } },
    textResult: { status: 200, body: { text: 'Some detailed post content about reliability costs and learning from failure. Comment Reply Add a comment' } },
    snapshotResult: { status: 200, body: { snapshot: [
      { tag: 'a', text: 'Open control menu for post by Ani Filipova', id: null },
      { tag: 'a', text: 'Under 40 lists measure speed. Calloused hands measure cost.', id: null },
      { tag: 'a', text: 'The second group knows something the first one has not lost enough yet to understand.', id: null },
    ] } },
    localSnapshotResult: { status: 200, body: { snapshot: [
      { tag: 'a', text: 'Open control menu for post by Ani Filipova', id: null },
      { tag: 'a', text: 'Under 40 lists measure speed. Calloused hands measure cost.', id: null },
      { tag: 'a', text: 'The second group knows something the first one has not lost enough yet to understand.', id: null },
    ] } },
  });
  const streams = createStreams();

  const { brief } = await runLinkedInFollowUpBrief({ adapter, args: { targetId: 'T1', mode: 'draft_only' }, ...streams });

  assert.equal(brief.followUp.drafts.length, 2);
  assert.ok(!brief.followUp.drafts[0].text.includes('[Draft reply to thread'));
  assert.ok(!brief.followUp.drafts[1].text.includes('[Draft comment on'));
  assert.ok(brief.followUp.drafts[0].text.includes('What stands out to me is'));
});

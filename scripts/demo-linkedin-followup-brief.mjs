#!/usr/bin/env node
/**
 * M14 Build 1: LinkedIn follow-up read proof.
 *
 * Read-only inspection of a chosen LinkedIn context via the trusted browser session.
 * Returns a structured follow-up brief useful for deciding what to do next.
 *
 * Demonstrates:
 *   GET /tabs → deterministic LinkedIn target selection → adoptTargetId → url() + text() → follow-up brief
 *
 * Usage:
 *   node scripts/demo-linkedin-followup-brief.mjs --target-id <id>
 *   node scripts/demo-linkedin-followup-brief.mjs --match-url <substring>
 *   node scripts/demo-linkedin-followup-brief.mjs --match-title <substring>
 *
 * Options:
 *   --base-url <url>    Bridge base URL (default: http://127.0.0.1:7820)
 *   --token <token>     Bearer token (if BRIDGE_API_TOKEN is set on the bridge)
 *   --target-id <id>    Select tab by exact CDP target id (from GET /tabs)
 *   --match-url <str>   Select the one tab whose URL contains this string
 *   --match-title <str> Select the one tab whose title contains this string
 *
 * Exits 0 on PASS, 1 on FAIL.
 * Returns { exitCode, brief } — brief is null on failure.
 *
 * READ-ONLY: this script does not click, post, comment, or mutate any LinkedIn state.
 */
import { pathToFileURL } from 'node:url';
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

const EXCERPT_MAX_CHARS = 500;

export function parseArgs(argv) {
  const result = {
    baseUrl: 'http://127.0.0.1:7820',
    token: null,
    targetId: null,
    matchUrl: null,
    matchTitle: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url' && argv[i + 1]) result.baseUrl = argv[++i];
    else if (arg === '--token' && argv[i + 1]) result.token = argv[++i];
    else if (arg === '--target-id' && argv[i + 1]) result.targetId = argv[++i];
    else if (arg === '--match-url' && argv[i + 1]) result.matchUrl = argv[++i];
    else if (arg === '--match-title' && argv[i + 1]) result.matchTitle = argv[++i];
  }
  return result;
}

function createLogger(stdout, stderr) {
  const steps = [];
  return {
    ok(label, detail) {
      stdout.write(`  [OK] ${label}${detail ? ': ' + detail : ''}\n`);
      steps.push({ ok: true, label });
    },
    fail(label, detail) {
      stderr.write(`  [FAIL] ${label}${detail ? ': ' + detail : ''}\n`);
      steps.push({ ok: false, label });
    },
    steps,
  };
}

function buildExcerpt(text) {
  if (!text) return '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_MAX_CHARS) return collapsed;
  return collapsed.slice(0, EXCERPT_MAX_CHARS) + '…';
}

function isLinkedInUrl(url) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'www.linkedin.com' || hostname === 'linkedin.com';
  } catch {
    return false;
  }
}

function extractVisibleSignals(pageText) {
  if (!pageText) {
    return {
      commentsPresent: false,
      commentBoxesVisible: false,
      replyAffordancesVisible: false,
      interactionOpportunities: 0,
    };
  }
  const lower = pageText.toLowerCase();

  const commentPatterns = [/\bcomment/i, /\breply/i, /\breplies\b/i];
  const commentsPresent = commentPatterns.some((p) => p.test(pageText));

  const commentBoxPatterns = [/add a comment/i, /write a comment/i, /leave a comment/i];
  const commentBoxesVisible = commentBoxPatterns.some((p) => p.test(pageText));

  const replyPatterns = [/\breply\b/i, /\breplies\b/i];
  const replyAffordancesVisible = replyPatterns.some((p) => p.test(pageText));

  let interactionOpportunities = 0;
  if (commentsPresent) interactionOpportunities++;
  if (commentBoxesVisible) interactionOpportunities++;
  if (replyAffordancesVisible) interactionOpportunities++;

  return {
    commentsPresent,
    commentBoxesVisible,
    replyAffordancesVisible,
    interactionOpportunities,
  };
}

function buildFollowUpBrief({ selectedTab, readUrl, pageText }) {
  const isLinkedIn = isLinkedInUrl(readUrl);
  const signals = extractVisibleSignals(pageText);
  const notes = [];
  const limitations = [];

  notes.push('read-only inspection — no mutations performed');
  notes.push('signal extraction is heuristic text matching, not DOM analysis');

  if (!isLinkedIn) {
    limitations.push('readUrl does not appear to be a LinkedIn page — signals may be inaccurate');
  }
  limitations.push('page text may not reflect dynamically loaded content (comments behind "show more", etc.)');
  limitations.push('auth-gated content may not be visible depending on session state');

  return {
    ok: true,
    target: {
      id: selectedTab.id,
      title: selectedTab.title ?? null,
      url: selectedTab.url ?? null,
    },
    followUp: {
      surface: 'linkedin',
      postContext: {
        readUrl,
        title: selectedTab.title ?? null,
        textLength: pageText.length,
        excerpt: buildExcerpt(pageText),
      },
      visibleSignals: signals,
      suggestedMode: 'inspect_only',
      notes,
      limitations,
    },
  };
}

function selectTab(allTabs, { targetId, matchUrl, matchTitle }, stderr) {
  if (targetId) {
    const tab = allTabs.find((t) => t.id === targetId) ?? null;
    if (!tab) {
      stderr.write(`  [FAIL] target selection: no tab with id "${targetId}"\n`);
      stderr.write(`  available ids: ${allTabs.map((t) => t.id).join(', ') || 'none'}\n`);
      return null;
    }
    return tab;
  }

  if (matchUrl) {
    const matches = allTabs.filter((t) => t.url?.includes(matchUrl));
    if (matches.length === 0) {
      stderr.write(`  [FAIL] target selection: no tab with URL containing "${matchUrl}"\n`);
      stderr.write(`  available URLs: ${allTabs.map((t) => t.url).join(', ') || 'none'}\n`);
      return null;
    }
    if (matches.length > 1) {
      stderr.write(`  [FAIL] target selection: ${matches.length} tabs match URL "${matchUrl}" — be more specific or use --target-id\n`);
      for (const m of matches) stderr.write(`    id=${m.id}  url=${m.url}\n`);
      return null;
    }
    return matches[0];
  }

  const matches = allTabs.filter((t) => t.title?.includes(matchTitle));
  if (matches.length === 0) {
    stderr.write(`  [FAIL] target selection: no tab with title containing "${matchTitle}"\n`);
    stderr.write(`  available titles: ${allTabs.map((t) => t.title).join(', ') || 'none'}\n`);
    return null;
  }
  if (matches.length > 1) {
    stderr.write(`  [FAIL] target selection: ${matches.length} tabs match title "${matchTitle}" — be more specific or use --target-id\n`);
    for (const m of matches) stderr.write(`    id=${m.id}  title=${m.title}\n`);
    return null;
  }
  return matches[0];
}

export async function runLinkedInFollowUpBrief({
  adapter,
  args = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { targetId = null, matchUrl = null, matchTitle = null } = args;
  const logger = createLogger(stdout, stderr);

  const selectors = [targetId, matchUrl, matchTitle].filter(Boolean);
  if (selectors.length === 0) {
    stderr.write('[linkedin-followup] error: specify one of --target-id, --match-url, or --match-title\n');
    stderr.write('  example: --match-url "linkedin.com"\n');
    return { exitCode: 1, brief: null };
  }
  if (selectors.length > 1) {
    stderr.write('[linkedin-followup] error: specify only one of --target-id, --match-url, or --match-title\n');
    return { exitCode: 1, brief: null };
  }

  stdout.write('=== LinkedIn Follow-up Brief (M14 Build 1) ===\n');
  stdout.write(`bridge: ${args.baseUrl ?? 'http://127.0.0.1:7820'}\n`);
  if (targetId) stdout.write(`select: --target-id ${targetId}\n`);
  else if (matchUrl) stdout.write(`select: --match-url "${matchUrl}"\n`);
  else stdout.write(`select: --match-title "${matchTitle}"\n`);
  stdout.write('\n');

  // Step 1: health
  try {
    const { status, body } = await adapter.health();
    if (status === 200 && body?.ok) {
      logger.ok('health', 'bridge reachable');
    } else {
      logger.fail('health', `status=${status} ok=${body?.ok}`);
      stderr.write('\n[linkedin-followup] bridge not reachable — is it running?\n');
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('health', `unreachable: ${err.message}`);
    stderr.write(`\n[linkedin-followup] bridge not reachable — is it running on ${args.baseUrl ?? 'http://127.0.0.1:7820'}?\n`);
    return { exitCode: 1, brief: null };
  }

  // Step 2: state
  let controlState = null;
  try {
    const { status, body } = await adapter.state();
    if (status === 200) {
      controlState = body.controlState;
      logger.ok('state', controlState);
    } else {
      logger.fail('state', `status=${status}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('state', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 3: recover if needed
  if (controlState === 'ERROR' || controlState === 'DETACHED') {
    try {
      const { status, body } = await adapter.recover();
      if (status === 200) {
        controlState = body.controlState;
        logger.ok('recover', `-> ${controlState}`);
      } else {
        logger.fail('recover', `status=${status} code=${body?.code}`);
        return { exitCode: 1, brief: null };
      }
    } catch (err) {
      logger.fail('recover', err.message);
      return { exitCode: 1, brief: null };
    }
  }

  if (controlState !== 'ATTACHED' && controlState !== 'PAUSED') {
    logger.fail('pre-adopt state', `unexpected state: ${controlState}; expected ATTACHED or PAUSED`);
    return { exitCode: 1, brief: null };
  }

  // Step 4: enumerate tabs
  let allTabs = [];
  try {
    const { status, body } = await adapter.tabs();
    if (status === 200 && body?.ok) {
      allTabs = body.tabs ?? [];
      logger.ok('tabs', `${allTabs.length} open tab${allTabs.length !== 1 ? 's' : ''}`);
    } else {
      logger.fail('tabs', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('tabs', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 5: select target deterministically
  const selectedTab = selectTab(allTabs, { targetId, matchUrl, matchTitle }, stderr);
  if (!selectedTab) {
    return { exitCode: 1, brief: null };
  }
  logger.ok('target selected', `"${selectedTab.title ?? '(no title)'}": id=${selectedTab.id}`);

  // Step 6: pause if ATTACHED (skip if already PAUSED)
  if (controlState === 'ATTACHED') {
    try {
      const { status, body } = await adapter.pause({ reason: 'linkedin-followup-inspection' });
      if (status === 200) {
        logger.ok('pause', `-> ${body.controlState}`);
      } else {
        logger.fail('pause', `status=${status} code=${body?.code}`);
        return { exitCode: 1, brief: null };
      }
    } catch (err) {
      logger.fail('pause', err.message);
      return { exitCode: 1, brief: null };
    }
  } else {
    logger.ok('pause', 'skipped (already PAUSED)');
  }

  // Step 7: adopt the selected target explicitly
  let adoptedTarget = null;
  try {
    const { status, body } = await adapter.resume({ adoptTargetId: selectedTab.id });
    if (status === 200 && body?.ok) {
      adoptedTarget = body.adoptedTarget ?? null;
      logger.ok('adopt', `adoptTargetId=${selectedTab.id} -> ${body.controlState}`);
    } else {
      logger.fail('adopt', `status=${status} code=${body?.code} error=${body?.error}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('adopt', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 8: verify adoption
  if (!adoptedTarget) {
    logger.fail('verify adoption', 'adoptedTarget absent from response — adoption not confirmed by id');
    return { exitCode: 1, brief: null };
  }
  if (adoptedTarget.id !== selectedTab.id) {
    logger.fail('verify adoption', `adopted id ${adoptedTarget.id} does not match intended ${selectedTab.id}`);
    return { exitCode: 1, brief: null };
  }
  logger.ok('verify adoption', `adopted id matches intended (${adoptedTarget.id})`);

  // Step 9a: read URL of the adopted target
  let readUrl = null;
  try {
    const { status, body } = await adapter.url();
    if (status === 200 && body?.url) {
      readUrl = body.url;
      logger.ok('read/url', readUrl);
    } else {
      logger.fail('read/url', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('read/url', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 9b: read page text of the adopted target
  let pageText = null;
  try {
    const { status, body } = await adapter.text();
    if (status === 200 && typeof body?.text === 'string') {
      pageText = body.text;
      logger.ok('read/text', `${pageText.length} chars`);
    } else {
      logger.fail('read/text', `status=${status} code=${body?.code}`);
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('read/text', err.message);
    return { exitCode: 1, brief: null };
  }

  // Step 10: build structured follow-up brief
  const brief = buildFollowUpBrief({ selectedTab, readUrl, pageText });

  stdout.write('\nPASS — LinkedIn follow-up brief produced\n');
  stdout.write('\nWhat this workflow proved:\n');
  stdout.write('  - bridge reachable and responding\n');
  stdout.write('  - GET /tabs enumerates open tabs with ids, URLs, and titles\n');
  stdout.write('  - target selected deterministically by explicit selector\n');
  stdout.write('  - adoptTargetId confirmed by response body (adoptedTarget.id verified)\n');
  stdout.write('  - GET /page/url and GET /page/text completed after adoption\n');
  stdout.write('  - structured LinkedIn follow-up brief produced with visible signal extraction\n');
  stdout.write('\nWhat this workflow did NOT prove:\n');
  stdout.write('  - signal extraction is heuristic — it searches page text, not DOM structure\n');
  stdout.write('  - dynamically loaded content (comments behind "show more") may be missed\n');
  stdout.write('  - this is read-only — no mutations or public actions were performed\n');

  stdout.write('\n--- LinkedIn Follow-up Brief (JSON) ---\n');
  stdout.write(JSON.stringify(brief, null, 2));
  stdout.write('\n--- End ---\n');

  try {
    const { status, body } = await adapter.pause({ reason: 'linkedin-followup-complete' });
    if (status === 200) {
      logger.ok('pause (handoff)', `-> ${body.controlState}`);
    } else {
      logger.fail('pause (handoff)', `status=${status} code=${body?.code} — bridge left ATTACHED`);
    }
  } catch (err) {
    logger.fail('pause (handoff)', `${err.message} — bridge left ATTACHED`);
  }

  return { exitCode: 0, brief };
}

// Exported for testing
export { isLinkedInUrl, extractVisibleSignals };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const adapterOpts = { baseUrl: parsedArgs.baseUrl };
  if (parsedArgs.token) {
    const tok = parsedArgs.token;
    adapterOpts.fetchImpl = (url, init = {}) => {
      const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${tok}` };
      return globalThis.fetch(url, { ...init, headers });
    };
  }
  const adapter = createOpenClawAdapter(adapterOpts);
  const { exitCode } = await runLinkedInFollowUpBrief({ adapter, args: parsedArgs });
  process.exitCode = exitCode;
}

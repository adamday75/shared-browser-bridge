#!/usr/bin/env node
/**
 * M11 workflow: inspect a chosen tab and return a structured page brief.
 *
 * Demonstrates the OpenClaw-native inspection pattern:
 *   GET /tabs → deterministic target selection → adoptTargetId → url() + text() → brief
 *
 * Usage:
 *   node scripts/demo-openclaw-page-brief.mjs --target-id <id>
 *   node scripts/demo-openclaw-page-brief.mjs --match-url <substring>
 *   node scripts/demo-openclaw-page-brief.mjs --match-title <substring>
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

function buildBrief({ selectedTab, readUrl, pageText, multiTab }) {
  const notes = [];
  if (multiTab) {
    notes.push(
      'multiple tabs open: url() and text() both read the first CDP-listed target, not the adopted tab — ' +
      'in a single-tab session the two are identical'
    );
  }
  notes.push('no model-driven summarization — excerpt is raw page text, whitespace-collapsed');

  return {
    ok: true,
    target: {
      id: selectedTab.id,
      title: selectedTab.title ?? null,
      url: selectedTab.url ?? null,
    },
    page: {
      readUrl,
      textLength: pageText.length,
      excerpt: buildExcerpt(pageText),
      notes,
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

export async function runPageBrief({
  adapter,
  args = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { targetId = null, matchUrl = null, matchTitle = null } = args;
  const logger = createLogger(stdout, stderr);

  const selectors = [targetId, matchUrl, matchTitle].filter(Boolean);
  if (selectors.length === 0) {
    stderr.write('[page-brief] error: specify one of --target-id, --match-url, or --match-title\n');
    stderr.write('  example: --match-url "example.com"\n');
    return { exitCode: 1, brief: null };
  }
  if (selectors.length > 1) {
    stderr.write('[page-brief] error: specify only one of --target-id, --match-url, or --match-title\n');
    return { exitCode: 1, brief: null };
  }

  stdout.write('=== OpenClaw Page Brief ===\n');
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
      stderr.write('\n[page-brief] bridge not reachable — is it running?\n');
      return { exitCode: 1, brief: null };
    }
  } catch (err) {
    logger.fail('health', `unreachable: ${err.message}`);
    stderr.write(`\n[page-brief] bridge not reachable — is it running on ${args.baseUrl ?? 'http://127.0.0.1:7820'}?\n`);
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
      const { status, body } = await adapter.pause({ reason: 'page-brief-inspection' });
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

  // Step 9a: read URL (operates on first CDP-listed target)
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

  // Step 9b: read page text (operates on first CDP-listed target)
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

  // Step 10: build structured brief
  const brief = buildBrief({
    selectedTab,
    readUrl,
    pageText,
    multiTab: allTabs.length > 1,
  });

  stdout.write('\nPASS — page brief produced\n');
  stdout.write('\nWhat this workflow proved:\n');
  stdout.write('  - bridge reachable and responding\n');
  stdout.write('  - GET /tabs enumerates open tabs with ids, URLs, and titles\n');
  stdout.write('  - target selected deterministically by explicit selector\n');
  stdout.write('  - adoptTargetId confirmed by response body (adoptedTarget.id verified)\n');
  stdout.write('  - GET /page/url and GET /page/text completed after adoption\n');
  stdout.write('  - structured page brief produced without model-driven summarization\n');
  stdout.write('\nWhat this workflow did NOT prove:\n');
  stdout.write('  - url() and text() both read the first CDP-listed target, not the adopted tab;\n');
  stdout.write("    with multiple tabs open, neither read is guaranteed to reflect the adopted tab\n");
  stdout.write('  - adoption does not affect which tab Chrome displays to the human\n');
  stdout.write('  - page reads are not guaranteed to reflect dynamic or auth-gated content\n');

  stdout.write('\n--- Page Brief (JSON) ---\n');
  stdout.write(JSON.stringify(brief, null, 2));
  stdout.write('\n--- End ---\n');

  try {
    const { status, body } = await adapter.pause({ reason: 'page-brief-complete' });
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
  const { exitCode } = await runPageBrief({ adapter, args: parsedArgs });
  process.exitCode = exitCode;
}

#!/usr/bin/env node
/**
 * M8 proof script: explicit target selection workflow.
 *
 * Demonstrates: GET /tabs → select target deterministically → adoptTargetId → read.
 * This is the primary end-to-end proof path for explicit target usage.
 *
 * Usage:
 *   node scripts/demo-explicit-target-flow.mjs --target-id <id>
 *   node scripts/demo-explicit-target-flow.mjs --match-url <substring>
 *   node scripts/demo-explicit-target-flow.mjs --match-title <substring>
 *
 * Options:
 *   --base-url <url>    Bridge base URL (default: http://127.0.0.1:7820)
 *   --token <token>     Bearer token (required if BRIDGE_API_TOKEN is set on the bridge)
 *   --target-id <id>    Select tab by exact CDP target id (from GET /tabs)
 *   --match-url <str>   Select the one tab whose URL contains this string
 *   --match-title <str> Select the one tab whose title contains this string
 *
 * Exits 0 on PASS, 1 on FAIL.
 */
import { pathToFileURL } from 'node:url';
import { createOpenClawAdapter } from '../src/adapters/openclaw.js';

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

function printSummary(stdout, stderr, passed) {
  stdout.write('\n');
  if (passed) {
    stdout.write('PASS — explicit target adoption demonstrated end-to-end\n');
    stdout.write('\nWhat this demo proved:\n');
    stdout.write('  - bridge reachable and responding\n');
    stdout.write('  - GET /tabs enumerates open tabs with ids and URLs\n');
    stdout.write('  - target selected deterministically (not by tab order)\n');
    stdout.write('  - adoptTargetId confirmed by response body (adoptedTarget.id verified)\n');
    stdout.write('  - GET /page/url completed successfully after adoption\n');
    stdout.write('\nWhat this demo did NOT prove:\n');
    stdout.write('  - GET /page/url reads the first CDP-listed target, not the stored baseline;\n');
    stdout.write('    with multiple tabs open, the URL read may not match the adopted tab\'s URL\n');
    stdout.write('  - adoption does not affect which tab Chrome displays to the human\n');
    stdout.write('  - no mutation or account action was performed (intentionally read-only)\n');
  } else {
    stderr.write('\nFAIL — demo did not complete (see steps above)\n');
  }
}

export async function runDemo({
  adapter,
  args = {},
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  const { targetId = null, matchUrl = null, matchTitle = null } = args;
  const logger = createLogger(stdout, stderr);

  const selectors = [targetId, matchUrl, matchTitle].filter(Boolean);
  if (selectors.length === 0) {
    stderr.write('[demo] error: specify one of --target-id, --match-url, or --match-title\n');
    stderr.write('  example: --match-url "example.com"\n');
    return 1;
  }
  if (selectors.length > 1) {
    stderr.write('[demo] error: specify only one of --target-id, --match-url, or --match-title\n');
    return 1;
  }

  stdout.write('=== Explicit Target Flow Demo ===\n');
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
      stderr.write('\n[demo] bridge not reachable — is it running?\n');
      printSummary(stdout, stderr, false);
      return 1;
    }
  } catch (err) {
    logger.fail('health', `unreachable: ${err.message}`);
    stderr.write(`\n[demo] bridge not reachable — is it running on ${args.baseUrl ?? 'http://127.0.0.1:7820'}?\n`);
    printSummary(stdout, stderr, false);
    return 1;
  }

  // Step 2: initial state
  let controlState = null;
  try {
    const { status, body } = await adapter.state();
    if (status === 200) {
      controlState = body.controlState;
      logger.ok('state', controlState);
    } else {
      logger.fail('state', `status=${status}`);
      printSummary(stdout, stderr, false);
      return 1;
    }
  } catch (err) {
    logger.fail('state', err.message);
    printSummary(stdout, stderr, false);
    return 1;
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
        printSummary(stdout, stderr, false);
        return 1;
      }
    } catch (err) {
      logger.fail('recover', err.message);
      printSummary(stdout, stderr, false);
      return 1;
    }
  }

  if (controlState !== 'ATTACHED' && controlState !== 'PAUSED') {
    logger.fail('pre-adopt state', `unexpected state: ${controlState}; expected ATTACHED or PAUSED`);
    printSummary(stdout, stderr, false);
    return 1;
  }

  // Step 4: enumerate tabs
  let allTabs = [];
  let baselineTargetId = null;
  try {
    const { status, body } = await adapter.tabs();
    if (status === 200 && body?.ok) {
      allTabs = body.tabs ?? [];
      baselineTargetId = body.baselineTargetId ?? null;
      logger.ok('tabs', `${allTabs.length} open tab${allTabs.length !== 1 ? 's' : ''}, baseline=${baselineTargetId ?? 'none'}`);
    } else {
      logger.fail('tabs', `status=${status} code=${body?.code}`);
      printSummary(stdout, stderr, false);
      return 1;
    }
  } catch (err) {
    logger.fail('tabs', err.message);
    printSummary(stdout, stderr, false);
    return 1;
  }

  // Step 5: select target deterministically
  let selectedTab = null;
  if (targetId) {
    selectedTab = allTabs.find((t) => t.id === targetId) ?? null;
    if (!selectedTab) {
      logger.fail('target selection', `no tab with id "${targetId}"`);
      stderr.write(`  available ids: ${allTabs.map((t) => t.id).join(', ') || 'none'}\n`);
      printSummary(stdout, stderr, false);
      return 1;
    }
  } else if (matchUrl) {
    const matches = allTabs.filter((t) => t.url?.includes(matchUrl));
    if (matches.length === 0) {
      logger.fail('target selection', `no tab with URL containing "${matchUrl}"`);
      stderr.write(`  available URLs: ${allTabs.map((t) => t.url).join(', ') || 'none'}\n`);
      printSummary(stdout, stderr, false);
      return 1;
    }
    if (matches.length > 1) {
      logger.fail('target selection', `${matches.length} tabs match URL "${matchUrl}" — be more specific or use --target-id`);
      for (const m of matches) {
        stderr.write(`    id=${m.id}  url=${m.url}\n`);
      }
      printSummary(stdout, stderr, false);
      return 1;
    }
    selectedTab = matches[0];
  } else {
    const matches = allTabs.filter((t) => t.title?.includes(matchTitle));
    if (matches.length === 0) {
      logger.fail('target selection', `no tab with title containing "${matchTitle}"`);
      stderr.write(`  available titles: ${allTabs.map((t) => t.title).join(', ') || 'none'}\n`);
      printSummary(stdout, stderr, false);
      return 1;
    }
    if (matches.length > 1) {
      logger.fail('target selection', `${matches.length} tabs match title "${matchTitle}" — be more specific or use --target-id`);
      for (const m of matches) {
        stderr.write(`    id=${m.id}  title=${m.title}\n`);
      }
      printSummary(stdout, stderr, false);
      return 1;
    }
    selectedTab = matches[0];
  }

  logger.ok('target selected', `"${selectedTab.title ?? '(no title)'}": id=${selectedTab.id} url=${selectedTab.url}`);

  // Step 6: pause if ATTACHED (skip if already PAUSED)
  if (controlState === 'ATTACHED') {
    try {
      const { status, body } = await adapter.pause({ reason: 'explicit-target-demo' });
      if (status === 200) {
        logger.ok('pause', `-> ${body.controlState}`);
      } else {
        logger.fail('pause', `status=${status} code=${body?.code}`);
        printSummary(stdout, stderr, false);
        return 1;
      }
    } catch (err) {
      logger.fail('pause', err.message);
      printSummary(stdout, stderr, false);
      return 1;
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
      printSummary(stdout, stderr, false);
      return 1;
    }
  } catch (err) {
    logger.fail('adopt', err.message);
    printSummary(stdout, stderr, false);
    return 1;
  }

  // Step 8: verify the adopted target matches the intended target
  if (adoptedTarget) {
    if (adoptedTarget.id === selectedTab.id) {
      logger.ok('verify adoption', `adopted id matches intended (${adoptedTarget.id})`);
    } else {
      logger.fail('verify adoption', `adopted id ${adoptedTarget.id} does not match intended ${selectedTab.id}`);
      printSummary(stdout, stderr, false);
      return 1;
    }
  } else {
    logger.fail('verify adoption', 'adoptedTarget absent from response — adoption not confirmed by id');
    printSummary(stdout, stderr, false);
    return 1;
  }

  // Step 9: safe read — GET /page/url
  let readUrl = null;
  try {
    const { status, body } = await adapter.url();
    if (status === 200 && body?.url) {
      readUrl = body.url;
      logger.ok('read/url', readUrl);
      if (allTabs.length > 1) {
        stdout.write(`         (adopted tab URL: ${selectedTab.url}  |  CDP first-listed URL: ${readUrl})\n`);
        if (readUrl !== selectedTab.url) {
          stdout.write('         URLs differ — expected with multiple tabs: GET /page/url reads the first CDP-listed target\n');
        }
      }
    } else {
      logger.fail('read/url', `status=${status} code=${body?.code}`);
      printSummary(stdout, stderr, false);
      return 1;
    }
  } catch (err) {
    logger.fail('read/url', err.message);
    printSummary(stdout, stderr, false);
    return 1;
  }

  printSummary(stdout, stderr, true);
  return 0;
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
  process.exitCode = await runDemo({
    adapter,
    args: parsedArgs,
  });
}

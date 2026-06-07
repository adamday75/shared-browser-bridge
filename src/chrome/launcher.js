import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_LAUNCH_TIMEOUT_MS = 8000;
const POLL_INTERVAL_MS = 300;

const LOCAL_ATTACH_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLocalAttachHost(host) {
  return LOCAL_ATTACH_HOSTS.has(host);
}

function candidateChromePaths() {
  const candidates = [];
  const { ProgramFiles, ProgramW6432, LOCALAPPDATA } = process.env;
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  for (const base of [ProgramFiles, programFilesX86, ProgramW6432, LOCALAPPDATA]) {
    if (base) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  }

  // Linux fallbacks so the same code path can be developed and verified from WSL.
  candidates.push(
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  );

  return candidates;
}

export function findChromeExecutable() {
  for (const candidate of candidateChromePaths()) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`request to ${url} failed with status ${response.status}`);
  }
  return response.json();
}

async function waitForCdp(versionUrl, fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(versionUrl, fetchImpl);
    } catch (err) {
      lastError = err;
      await delay(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Chrome did not expose a CDP endpoint at ${versionUrl} within ${timeoutMs}ms (${lastError?.message})`);
}

/**
 * Resolve a working CDP target: attach to an already-running Chrome first
 * (the real, visible, logged-in session), and only launch a new Chrome
 * process as a fallback when nothing is listening yet. Launching reuses the
 * default profile (no throwaway --user-data-dir) so the launched browser is
 * still the user's real session, not a fake managed one.
 */
export async function resolveChromeTarget({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  fetchImpl = fetch,
  spawnImpl = spawn,
  launchTimeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  allowRemoteLaunch = false,
  logger = console,
} = {}) {
  const endpoint = `http://${host}:${port}`;
  const versionUrl = `${endpoint}/json/version`;

  try {
    const version = await fetchJson(versionUrl, fetchImpl);
    logger.log(`[chrome] attached to existing CDP endpoint at ${endpoint} (${version.Browser})`);
    return {
      mode: 'attached',
      endpoint,
      host,
      port,
      browser: version.Browser,
      userAgent: version['User-Agent'],
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    };
  } catch (attachErr) {
    // Launch fallback would spawn a *local* Chrome. That's only honest when the
    // CDP target is local too — for a remote (e.g. Windows-host-from-WSL) target,
    // launching a local browser would silently swap in the wrong browser, which
    // is exactly the fake-browser drift this project rejects.
    if (!isLocalAttachHost(host) && !allowRemoteLaunch) {
      throw new Error(
        `Could not attach to CDP endpoint at ${endpoint} (${attachErr.message}). ` +
          `Refusing to launch a local Chrome as a fallback for a non-local CDP host (${host}) — ` +
          'that would control a different browser than the one this bridge is supposed to drive. ' +
          `Start Chrome on ${host} with --remote-debugging-port=${port} so the bridge can attach, ` +
          'or set CDP_ALLOW_REMOTE_LAUNCH=1 to explicitly allow launch fallback for non-local hosts.'
      );
    }
    logger.log(`[chrome] no CDP endpoint at ${endpoint} yet (${attachErr.message}); trying to launch Chrome`);
  }

  const executablePath = findChromeExecutable();
  if (!executablePath) {
    throw new Error(
      `No reachable CDP endpoint at ${endpoint} and no Chrome executable found to launch. ` +
        'Start Chrome with --remote-debugging-port to attach, or install Chrome.'
    );
  }

  logger.log(`[chrome] launching ${executablePath} with --remote-debugging-port=${port}`);
  const child = spawnImpl(
    executablePath,
    [`--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  const version = await waitForCdp(versionUrl, fetchImpl, launchTimeoutMs);
  logger.log(`[chrome] launched Chrome (pid ${child.pid}) and confirmed CDP at ${endpoint}`);
  return {
    mode: 'launched',
    endpoint,
    host,
    port,
    pid: child.pid,
    browser: version.Browser,
    userAgent: version['User-Agent'],
    webSocketDebuggerUrl: version.webSocketDebuggerUrl,
  };
}

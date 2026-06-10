export function createOpenClawAdapter({
  baseUrl = 'http://127.0.0.1:7820',
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  async function request(method, path, body) {
    const url = `${baseUrl}${path}`;
    const init = { method, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }

    const res = await fetchImpl(url, init);
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  }

  async function health() {
    return request('GET', '/health');
  }

  async function tabs() {
    return request('GET', '/tabs');
  }

  async function goto({ url }) {
    if (typeof url !== 'string' || !url.trim()) {
      throw new TypeError('goto requires a non-empty url string');
    }
    return request('POST', '/page/goto', { url });
  }

  async function url() {
    return request('GET', '/page/url');
  }

  async function text() {
    return request('GET', '/page/text');
  }

  async function snapshot() {
    return request('GET', '/page/snapshot');
  }

  async function click({ selector }) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new TypeError('click requires a non-empty selector string');
    }
    return request('POST', '/page/click', { selector });
  }

  async function type({ selector, text: textValue }) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new TypeError('type requires a non-empty selector string');
    }
    if (typeof textValue !== 'string') {
      throw new TypeError('type requires a text string');
    }
    return request('POST', '/page/type', { selector, text: textValue });
  }

  async function pause({ reason } = {}) {
    const body = {};
    if (reason !== undefined) body.reason = reason;
    return request('POST', '/control/pause', body);
  }

  async function resume({ force, adoptCurrentTarget, adoptTargetId } = {}) {
    const body = {};
    if (force !== undefined) body.force = force;
    if (adoptCurrentTarget !== undefined) body.adoptCurrentTarget = adoptCurrentTarget;
    if (adoptTargetId !== undefined) body.adoptTargetId = adoptTargetId;
    return request('POST', '/control/resume', body);
  }

  async function state() {
    return request('GET', '/control/state');
  }

  async function recover() {
    return request('POST', '/control/recover');
  }

  return { health, tabs, goto, url, text, snapshot, click, type, pause, resume, state, recover };
}

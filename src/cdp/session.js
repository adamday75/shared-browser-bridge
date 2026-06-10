export class CdpConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdpConnectionError';
  }
}

export class NoPageTargetError extends Error {
  constructor() {
    super('no open page tabs to act on');
    this.name = 'NoPageTargetError';
  }
}

/**
 * Thin client over Chrome's CDP HTTP endpoint (the same /json/* surface the
 * launcher uses to validate an attach). Milestone 1 only needs to read tab
 * state, so there is no websocket connection here yet.
 */
export function createCdpSession({ endpoint, fetchImpl = fetch }) {
  if (!endpoint) {
    throw new Error('createCdpSession requires an endpoint');
  }

  async function getVersion() {
    let response;
    try {
      response = await fetchImpl(`${endpoint}/json/version`);
    } catch (err) {
      throw new CdpConnectionError(`CDP connection failed: ${err.message}`);
    }
    if (!response.ok) {
      throw new CdpConnectionError(`CDP version check failed with status ${response.status}`);
    }
    return response.json();
  }

  async function listPageTargets() {
    let response;
    try {
      response = await fetchImpl(`${endpoint}/json/list`);
    } catch (err) {
      throw new CdpConnectionError(`CDP connection failed: ${err.message}`);
    }
    if (!response.ok) {
      throw new CdpConnectionError(`CDP tab list failed with status ${response.status}`);
    }
    const targets = await response.json();
    return targets.filter((target) => target.type === 'page');
  }

  async function listTabs() {
    const targets = await listPageTargets();
    return targets.map((target) => ({
      id: target.id,
      title: target.title,
      url: target.url,
    }));
  }

  /**
   * Returns the first open page target from CDP's /json/list.
   *
   * CDP's HTTP /json/list surface does not expose which tab the human is
   * currently focused on. The ordering is browser-internal and not guaranteed
   * to reflect human focus or tab activation order. This returns whatever
   * Chrome lists first among open page targets.
   *
   * For explicit target selection by id, enumerate all available targets with
   * listTabs() and pass the chosen id as adoptTargetId on POST /control/resume.
   */
  async function getFirstPageTarget() {
    const targets = await listPageTargets();
    const target = targets[0];
    if (!target) {
      throw new NoPageTargetError();
    }
    return target;
  }

  async function getTargetById(id) {
    const targets = await listPageTargets();
    const target = targets.find((t) => t.id === id);
    if (!target) {
      throw new NoPageTargetError();
    }
    return target;
  }

  return { endpoint, getVersion, listTabs, getFirstPageTarget, getTargetById };
}

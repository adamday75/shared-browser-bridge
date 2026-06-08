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
   * CDP's HTTP /json/list surface has no concept of "focused" tab (noted in
   * the Milestone 1 implementation note), so page actions operate on the
   * first open page target. This is an honest stand-in for active-tab
   * tracking, which belongs with the Milestone 3 handoff/state work.
   */
  async function getFirstPageTarget() {
    const targets = await listPageTargets();
    const target = targets[0];
    if (!target) {
      throw new NoPageTargetError();
    }
    return target;
  }

  return { endpoint, getVersion, listTabs, getFirstPageTarget };
}

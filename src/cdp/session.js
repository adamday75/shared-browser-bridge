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
    const response = await fetchImpl(`${endpoint}/json/version`);
    if (!response.ok) {
      throw new Error(`CDP version check failed with status ${response.status}`);
    }
    return response.json();
  }

  async function listPageTargets() {
    const response = await fetchImpl(`${endpoint}/json/list`);
    if (!response.ok) {
      throw new Error(`CDP tab list failed with status ${response.status}`);
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
      throw new Error('no open page tabs to act on');
    }
    return target;
  }

  return { endpoint, getVersion, listTabs, getFirstPageTarget };
}

import { CdpConnectionError } from './session.js';

export function createSessionSlot(initialSession = null) {
  let current = initialSession;

  function requireCurrent() {
    if (!current) {
      throw new CdpConnectionError('not attached to Chrome');
    }
    return current;
  }

  return {
    getCurrent() {
      return current;
    },
    setCurrent(nextSession) {
      current = nextSession;
    },
    clearCurrent() {
      current = null;
    },
    async getVersion() {
      return requireCurrent().getVersion();
    },
    async listTabs() {
      return requireCurrent().listTabs();
    },
    async getFirstPageTarget() {
      return requireCurrent().getFirstPageTarget();
    },
  };
}

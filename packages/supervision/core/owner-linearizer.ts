/**
 * One Supervision-owner queue per canonical data root.
 *
 * The Foundation store already serializes each append. AMD-003 needs a wider
 * owner decision (policy re-read → legacy/cooldown scans → append), so every
 * composition in this process joins this shared queue instead of protecting
 * only its own instance.
 */
const ownerTails = new Map<string, Promise<void>>();

export interface SupervisionOwnerLinearizer {
  run<Value>(operation: () => Promise<Value>): Promise<Value>;
}

export function createSupervisionOwnerLinearizer(key: string): SupervisionOwnerLinearizer {
  return {
    async run<Value>(operation: () => Promise<Value>): Promise<Value> {
      const prior = ownerTails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      const tail = prior.then(() => current);
      ownerTails.set(key, tail);
      await prior;
      try {
        return await operation();
      } finally {
        release();
        if (ownerTails.get(key) === tail) ownerTails.delete(key);
      }
    },
  };
}

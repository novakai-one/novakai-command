/**
 * One Supervision-owner queue per canonical data root.
 *
 * The Foundation store already serializes each append. AMD-003 needs a wider
 * owner decision (policy re-read → legacy/cooldown scans → append), so every
 * composition in this process joins this shared queue instead of protecting
 * only its own instance.
 */
const ownerTails = new Map<string, Promise<void>>();
const RUN_METHOD = 'run';

export interface SupervisionOwnerLinearizer {
  run<Value>(operation: () => Promise<Value>): Promise<Value>;
}

export function createSupervisionOwnerLinearizer(dataRootKey: string): SupervisionOwnerLinearizer {
  return {
    async [RUN_METHOD]<Value>(operation: () => Promise<Value>): Promise<Value> {
      const prior = ownerTails.get(dataRootKey) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      const tail = prior.then(() => current);
      ownerTails.set(dataRootKey, tail);
      await prior;
      try {
        return await operation();
      } finally {
        release();
        if (ownerTails.get(dataRootKey) === tail) ownerTails.delete(dataRootKey);
      }
    },
  };
}

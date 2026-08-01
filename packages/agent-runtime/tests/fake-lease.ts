// A single-instance lease shared by several in-process "hosts".
//
// Real OS lease semantics without spawning processes: one holder at a time,
// stealable only from a holder that is provably gone.
import type { InstanceLease } from '../contract/index.js';

export interface FakeLeaseWorld {
  forProcess(processId: number): InstanceLease;
  /** The holder died without releasing — power loss, crash, force-quit. */
  kill(processId: number): void;
}

export function createFakeInstanceLease(): FakeLeaseWorld {
  let holder: number | null = null;
  const dead = new Set<number>();

  const alive = (processId: number): boolean => !dead.has(processId);

  return {
    kill(processId: number): void {
      dead.add(processId);
    },
    forProcess(processId: number): InstanceLease {
      return {
        acquire() {
          if (holder === processId) return { held: true };
          if (holder !== null && alive(holder)) return { held: false, holderPid: holder };
          holder = processId; // free, or stolen from a provably dead holder
          return { held: true };
        },
        release() {
          if (holder === processId) holder = null;
        },
        heldByThisProcess() {
          return holder === processId && alive(processId);
        },
        holderPid() {
          return holder;
        },
        holderAlive() {
          return holder !== null && alive(holder);
        },
      };
    },
  };
}

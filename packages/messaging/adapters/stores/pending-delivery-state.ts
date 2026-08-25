import type {
  PendingDeliveryTransitionInput,
  PendingDeliveryTransitionResult,
} from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import { assertPendingDeliveryTransition } from '../../core/delivery/transitions.js';

/** Replay envelope for one or more PendingDelivery mutations. */
export interface PersistedPendingDeliveryMutation {
  readonly sequence: number;
  readonly deliveries: readonly PendingDelivery[];
}

type Persist = (deliveries: readonly PendingDelivery[]) => Promise<void>;

/** Serialized idempotency and CAS semantics shared by both store adapters. */
export class PendingDeliveryState {
  private readonly deliveries = new Map<string, PendingDelivery>();
  private mutationTail: Promise<unknown> = Promise.resolve();

  restore(mutations: readonly PersistedPendingDeliveryMutation[]): void {
    for (const mutation of [...mutations].sort((left, right) => left.sequence - right.sequence)) {
      this.apply(mutation.deliveries);
    }
  }

  accept(delivery: PendingDelivery, persist?: Persist): Promise<PendingDelivery> {
    return this.serialized(async () => {
      const existing = this.deliveries.get(delivery.id);
      if (existing !== undefined) {
        if (existing.transcriptLineId !== delivery.transcriptLineId
          || existing.recipientAgentId !== delivery.recipientAgentId) {
          throw new Error(`PendingDelivery ${delivery.id} conflicts`);
        }
        return existing;
      }
      if (persist !== undefined) await persist([delivery]);
      this.apply([delivery]);
      return delivery;
    });
  }

  transition(
    input: PendingDeliveryTransitionInput,
    persist?: Persist,
  ): Promise<PendingDeliveryTransitionResult> {
    return this.serialized(async () => {
      const current = this.required(input.id);
      if (current.state !== input.expectedState) {
        return { delivery: current, changed: false };
      }
      assertPendingDeliveryTransition(
        input.id,
        current.state,
        input.state,
        input.failure,
      );
      const next: PendingDelivery = {
        ...current,
        state: input.state,
        updatedAt: input.updatedAt as PendingDelivery['updatedAt'],
        ...(input.failure === undefined ? {} : { failure: input.failure }),
      };
      if (persist !== undefined) await persist([next]);
      this.apply([next]);
      return { delivery: next, changed: true };
    });
  }

  list(): readonly PendingDelivery[] {
    return [...this.deliveries.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  private required(id: string): PendingDelivery {
    const delivery = this.deliveries.get(id);
    if (delivery === undefined) throw new Error(`Unknown PendingDelivery ${id}`);
    return delivery;
  }

  private apply(deliveries: readonly PendingDelivery[]): void {
    for (const delivery of deliveries) this.deliveries.set(delivery.id, delivery);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

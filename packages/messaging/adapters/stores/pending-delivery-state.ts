import type {
  AcceptPendingDeliveryResult,
  PendingDeliveryTransitionInput,
  PendingDeliveryTransitionResult,
} from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import { MessagingError } from '../../contract/types.js';
import { assertPendingDeliveryTransition } from '../../core/delivery/transitions.js';
import { compareStrings } from '../../core/compare.js';
import { present } from '../../core/send/sparse.js';

/** Replay envelope for one or more PendingDelivery mutations. */
export interface PersistedPendingDeliveryMutation {
  readonly sequence: number;
  readonly deliveries: readonly PendingDelivery[];
}

type Persist = (deliveries: readonly PendingDelivery[]) => Promise<void>;

/**
 * Serialized idempotency and CAS semantics shared by both store adapters.
 * Crash recovery: persist precedes apply, so a crash mid-step replays from
 * the store on next open.
 */
export class PendingDeliveryState {
  private readonly deliveries = new Map<string, PendingDelivery>();
  private mutationTail: Promise<unknown> = Promise.resolve();

  restore(mutations: readonly PersistedPendingDeliveryMutation[]): void {
    for (const mutation of [...mutations].sort((left, right) => left.sequence - right.sequence)) {
      this.apply(mutation.deliveries);
    }
  }

  accept(delivery: PendingDelivery, persist?: Persist): Promise<AcceptPendingDeliveryResult> {
    return this.serialized(async () => {
      const existing = this.existingOrConflict(delivery);
      if (existing !== undefined) return { delivery: existing, duplicate: true };
      if (persist !== undefined) await persist([delivery]);
      this.apply([delivery]);
      return { delivery, duplicate: false };
    });
  }

  /**
   * The stored delivery with this id: identical means a duplicate accept, a
   * different payload under the same id is a typed conflict.
   */
  private existingOrConflict(delivery: PendingDelivery): PendingDelivery | undefined {
    const existing = this.deliveries.get(delivery.id);
    if (existing === undefined) return undefined;
    if (existing.transcriptLineId === delivery.transcriptLineId
      && existing.recipientAgentId === delivery.recipientAgentId) return existing;
    throw new MessagingError('IdempotencyConflict', {
      message: `PendingDelivery ${delivery.id} conflicts`,
      fields: { deliveryId: delivery.id },
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
        updatedAt: input.updatedAt,
        ...present('failure', input.failure),
      };
      if (persist !== undefined) await persist([next]);
      this.apply([next]);
      return { delivery: next, changed: true };
    });
  }

  list(): readonly PendingDelivery[] {
    return [...this.deliveries.values()].sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id));
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
    const chained = this.mutationTail.then(operation, operation);
    this.mutationTail = chained.then(() => undefined, () => undefined);
    return chained;
  }
}

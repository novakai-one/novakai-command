/**
 * The 4 events, mirroring contract/messaging-contract.json `events` exactly.
 *
 * MessageCommitted / DeliveryUpdated / PolicyChanged are committed-fact events:
 * journaled with sequence (Store-Seam §11.1), replayed by Subscribe.
 * PresenceChanged is an observation (R11): no sequence, not journaled,
 * never replayed.
 */

import type {
  PersonId,
  PolicyChangedPolicy,
  PresenceChangedChange,
  Sequence,
} from "./generated.js";
import type { Delivery, Message, Presence } from "./records.js";

/** A Message crossed the durability boundary. Emitted only after commit. */
export interface MessageCommittedEvent {
  sequence: Sequence;
  message: Message;
}

/** A per-recipient Delivery changed state. Failure states included (MSG-016). */
export interface DeliveryUpdatedEvent {
  sequence: Sequence;
  delivery: Delivery;
}

/** R11: a Presence opened/closed. Observation — no sequence, never replayed. */
export interface PresenceChangedEvent {
  presence: Presence;
  change: PresenceChangedChange;
}

/** A DND or contact policy changed. */
export interface PolicyChangedEvent {
  sequence: Sequence;
  personId: PersonId;
  policy: PolicyChangedPolicy;
  revision: number;
}

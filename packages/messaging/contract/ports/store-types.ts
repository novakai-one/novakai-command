/** Declaration-only records and outcomes used by the Messaging store port. */

import type {
  AcceptanceRecord,
  ClientMessageId,
  ContactPolicy,
  Cursor,
  Delivery,
  DeliveryId,
  DeliveryState,
  DndPolicy,
  Message,
  MessageId,
  PersonId,
  PolicyChangedPolicy,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  Template,
  ThreadId,
} from "../schemas.js";
import type {
  AgentEndpointClaim,
  AgentInboxItem,
} from "../../b3/contract/records.js";

export interface StoreUnavailableError { name: "StoreUnavailable"; message: string; retryable: boolean }
export interface StoreCorruptError { name: "StoreCorrupt"; message: string }
export interface StorageExhaustedError { name: "StorageExhausted"; message: string }
export interface IdempotencyConflictError {
  name: "IdempotencyConflict";
  clientMessageId: string;
  originalMessageId: MessageId;
}
export interface StateConflictError {
  name: "StateConflict";
  deliveryId: DeliveryId;
  expected: DeliveryState;
  actual: DeliveryState;
}
export interface RevisionConflictError { name: "RevisionConflict"; expected: number; actual: number }
export interface RecordNotFoundError { name: "RecordNotFound"; record: string; id: string }
export interface CursorInvalidError { name: "CursorInvalid"; cursor: string }
export interface SequenceExhaustedError { name: "SequenceExhausted" }

export type StoreError =
  | StoreUnavailableError
  | StoreCorruptError
  | StorageExhaustedError
  | IdempotencyConflictError
  | StateConflictError
  | RevisionConflictError
  | RecordNotFoundError
  | CursorInvalidError
  | SequenceExhaustedError;

export type StoreResult<T> = { kind: "ok"; value: T } | { kind: "error"; error: StoreError };

export interface DirectThreadRef {
  kind: "direct";
  pair: [PersonId, PersonId];
}

export interface RoomThreadRef {
  kind: "room";
  threadId: ThreadId;
}

export type AcceptanceThreadRef = DirectThreadRef | RoomThreadRef;

export interface AcceptanceInput {
  idempotency: {
    senderId: PersonId;
    clientMessageId: ClientMessageId;
    requestHash: RequestHash;
  };
  thread: AcceptanceThreadRef;
  message: Message;
  snapshot: RecipientSnapshot;
  deliveries: Delivery[];
  urgentDowngraded?: boolean;
  agentInboxItems?: readonly AgentInboxItem[];
}

export type AcceptanceOutcome =
  | {
      kind: "accepted";
      messageId: MessageId;
      threadId: ThreadId;
      sequence: Sequence;
      urgentDowngraded?: boolean;
    }
  | { kind: "duplicate"; original: AcceptanceRecord }
  | { kind: "conflict"; error: IdempotencyConflictError }
  | { kind: "failed"; error: StoreError };

export interface PageOptions {
  cursor?: Cursor;
  limit?: number;
}

export interface RoomThreadSpec {
  threadKind: "team" | "mission";
  authority: string;
  externalId: string;
}

export interface PolicyPair {
  contact?: ContactPolicy;
  dnd?: DndPolicy;
}

export interface TemplatePageOut {
  templates: Template[];
  nextCursor?: Cursor;
}

export interface PendingAcceptancePage {
  acceptances: AcceptanceRecord[];
  nextCursor?: Cursor;
}

export type JournalEntry =
  | { sequence: Sequence; kind: "MessageCommitted"; message: Message }
  | { sequence: Sequence; kind: "DeliveryUpdated"; delivery: Delivery }
  | {
      sequence: Sequence;
      kind: "PolicyChanged";
      personId: PersonId;
      policy: PolicyChangedPolicy;
      revision: number;
    }
  | { sequence: Sequence; kind: "TemplateWritten"; template: Template }
  | { sequence: Sequence; kind: "AgentEndpointChanged"; claim: AgentEndpointClaim }
  | { sequence: Sequence; kind: "AgentInboxChanged"; item: AgentInboxItem };

export interface AgentEndpointClaimInput {
  readonly claim: AgentEndpointClaim;
  readonly expectedEndpointGeneration: number;
}

export interface AgentEndpointTransferInput {
  readonly oldClaim: AgentEndpointClaim;
  readonly newClaim: AgentEndpointClaim;
  readonly inboxItems: readonly AgentInboxItem[];
  readonly expectedEndpointGeneration: number;
}

export interface AgentEndpointTransferOutcome {
  readonly claim: AgentEndpointClaim;
  readonly inboxItems: readonly AgentInboxItem[];
}

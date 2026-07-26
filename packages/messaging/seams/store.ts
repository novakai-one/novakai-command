/**
 * Store seam — Messaging-Store-Seam.md (Step 3a), including the §11 errata.
 *
 * The seam is DEEP (DEC-20): the core calls one operation per acceptance; it
 * never orchestrates append/find choreography across the seam. All writes to
 * authoritative Messaging records cross this interface; reads are of committed
 * state only, ordered by sequence ascending.
 *
 * The failure vocabulary (§6) is seam-internal: StateConflict / RevisionConflict
 * are normal concurrency outcomes handled inside the core (never public);
 * RecordNotFound maps to UnknownThread/UnknownMessage at the contract layer;
 * CursorInvalid maps to ValidationFailed; StoreUnavailable / StorageExhausted /
 * StoreCorrupt map to DependencyUnavailable{dependency: "store"}.
 *
 * The seam-level error names below are defined by Messaging-Store-Seam.md §6
 * (prose source) — they are NOT part of the public 13-error catalogue and so
 * are declared here, not generated from the contract JSON.
 */

import type {
  AcceptanceRecord,
  AttemptId,
  ClientMessageId,
  ContactPolicy,
  Cursor,
  Delivery,
  DeliveryAttempt,
  DeliveryId,
  DeliveryState,
  DeliveryStateReason,
  DndPolicy,
  Message,
  MessageId,
  PersonId,
  PolicyChangedPolicy,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  Template,
  TemplateId,
  Thread,
  ThreadId,
} from "../public/contract/index.js";

// --- §6 failure vocabulary ---------------------------------------------------

export interface StoreUnavailableError {
  name: "StoreUnavailable";
  message: string;
  retryable: boolean;
}
export interface StoreCorruptError {
  name: "StoreCorrupt";
  message: string;
}
export interface StorageExhaustedError {
  name: "StorageExhausted";
  message: string;
}
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
export interface RevisionConflictError {
  name: "RevisionConflict";
  expected: number;
  actual: number;
}
export interface RecordNotFoundError {
  name: "RecordNotFound";
  record: string;
  id: string;
}
export interface CursorInvalidError {
  name: "CursorInvalid";
  cursor: string;
}
export interface SequenceExhaustedError {
  name: "SequenceExhausted";
}

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

// --- §2 the acceptance transaction -------------------------------------------

export interface DirectThreadRef {
  kind: "direct";
  /** The two principals; the store canonicalises (sorts) the pair (DEC-03). */
  pair: [PersonId, PersonId];
}

export interface RoomThreadRef {
  kind: "room";
  /** Room Threads must already exist; unknown → failed { RecordNotFound }. */
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
  /**
   * Fully formed except `sequence` (assigned by the store inside the
   * transaction, §2.3). For a direct get-or-create the Thread may not exist
   * yet, so the store stamps the resolved threadId onto the Message and its
   * Deliveries at commit.
   */
  message: Message;
  /** Frozen recipient set (I5); committed atomically with the Message. Its
   * `blocked` set (R4) is authoritative AT COMMIT: the store stamps those
   * recipients' Deliveries terminal failed{blocked-by-contact-policy} inside
   * the transaction (§11.7). */
  snapshot: RecipientSnapshot;
  /**
   * One initial record per recipient (R5 initial state pending). Recipients
   * on the snapshot's blocked set do NOT stay pending: §11.7 commits them
   * terminal failed{blocked-by-contact-policy} in the same transaction.
   */
  deliveries: Delivery[];
  /** §11.3: persisted on the AcceptanceRecord so duplicate retries carry the typed outcome (MSG-010). */
  urgentDowngraded?: boolean;
}

export type AcceptanceOutcome =
  | {
      kind: "accepted";
      messageId: MessageId;
      threadId: ThreadId;
      sequence: Sequence;
      urgentDowngraded?: boolean;
    }
  /** Same key + same requestHash: the original acceptance, incl. persisted urgentDowngraded (§11.3). */
  | { kind: "duplicate"; original: AcceptanceRecord }
  /** Same key + different requestHash (A5). */
  | { kind: "conflict"; error: IdempotencyConflictError }
  /** §6 — NOTHING committed. */
  | { kind: "failed"; error: StoreError };

// --- §4 reads ----------------------------------------------------------------

export interface PageOptions {
  cursor?: Cursor;
  /** Clamped to constants.pageLimitMax, never rejected (§4). */
  limit?: number;
}

/**
 * §11.4 — the room key a Room Thread is created for (get-or-create). The
 * threadId is minted by the adapter via the clock/ID seam; the caller never
 * supplies it. The durable join to the owning capability is this key (G2).
 */
export interface RoomThreadSpec {
  threadKind: "team" | "mission";
  /** Name of the external membership authority (Team or Mission capability). */
  authority: string;
  /** The room's ID in that authority. */
  externalId: string;
}

/** §4 `getPolicy` — one Person's policy pair; absent halves are simply missing. */
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

// --- §11.1 the journal ---------------------------------------------------------

/**
 * Journal entry shape. Store-Seam §11.1 freezes WHAT is journaled (acceptance
 * commits, delivery transitions, policy writes, template writes — each with a
 * global sequence) but not the entry schema; these kinds mirror the
 * committed-fact event names for the three evented kinds, plus TemplateWritten
 * (templates have no public event).
 */
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
  | { sequence: Sequence; kind: "TemplateWritten"; template: Template };

// --- the seam ------------------------------------------------------------------

export interface MessagingStore {
  /** §2 — one atomic operation. All effects commit, or none do. */
  commitAcceptance(input: AcceptanceInput): Promise<AcceptanceOutcome>;

  /**
   * §11.4 — room Thread creation, get-or-create keyed by the room key
   * (authority, externalId): one Thread per room, forever; a concurrent or
   * repeated create proceeds against the existing Thread (not an error). No
   * public command exists — creation is capability-internal, driven by the
   * composition root from the membership adapter's room config (P4's
   * capability-to-capability shape). Not journaled (no committed-fact event
   * exists for Thread creation); durable adapters persist the op.
   */
  createRoomThread(room: RoomThreadSpec): Promise<StoreResult<Thread>>;

  // §4 reads (committed state only; ordered results by sequence ascending)
  getThread(threadId: ThreadId): Promise<StoreResult<Thread>>;
  getDirectThread(personA: PersonId, personB: PersonId): Promise<StoreResult<Thread>>;
  /**
   * §11.5 — every DIRECT Thread whose pair contains personId, plus EVERY room
   * Thread. Room membership filtering is the membership seam's truth, applied
   * by the core above the store (R3). Creation order (not contractual).
   */
  listThreadsForPerson(personId: PersonId): Promise<StoreResult<Thread[]>>;
  /**
   * A-R-N4-1 — EVERY direct Thread, unscoped by pair (creation order, same
   * ordering note as §11.5: Map insertion order, not contractual). The §11.5
   * read is pair-scoped by design; lane oversight (the oversight.read grant)
   * needs the unscoped enumeration. Rooms are never included — room
   * visibility stays membership-driven via §11.5 + the membership seam.
   */
  listDirectThreads(): Promise<StoreResult<Thread[]>>;
  getMessage(messageId: MessageId): Promise<StoreResult<Message>>;
  /**
   * §11.6 — the RecipientSnapshot frozen at acceptance (I5 evidence: the
   * recipient set, the blocked set, the membership revision). §11.7 note:
   * the DEC-21 sweep no longer reads it — blocked Deliveries are terminal
   * from the commit itself.
   */
  getSnapshot(messageId: MessageId): Promise<StoreResult<RecipientSnapshot>>;
  getMessages(threadId: ThreadId, options?: PageOptions): Promise<StoreResult<{ messages: Message[]; nextCursor?: Cursor }>>;
  /** §11.2: non-terminal Deliveries only (pending | held). Terminal states never appear. */
  getInbox(personId: PersonId, options?: PageOptions): Promise<StoreResult<{ messages: Message[]; nextCursor?: Cursor }>>;
  getDeliveries(messageId: MessageId): Promise<StoreResult<Delivery[]>>;
  findAcceptance(senderId: PersonId, clientMessageId: ClientMessageId): Promise<StoreResult<AcceptanceRecord>>;
  getPolicy(personId: PersonId): Promise<StoreResult<PolicyPair>>;
  getTemplate(templateId: TemplateId): Promise<StoreResult<Template>>;
  listTemplates(options?: PageOptions): Promise<StoreResult<TemplatePageOut>>;

  // §5 non-acceptance writes (single-record, optimistic concurrency)
  putPolicy(
    personId: PersonId,
    policy: ContactPolicy | DndPolicy,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>>;
  putTemplate(template: Template, expectedRevision?: number): Promise<StoreResult<{ revision: number }>>;
  retireTemplate(templateId: TemplateId, expectedRevision?: number): Promise<StoreResult<{ revision: number }>>;
  /**
   * CAS on the Delivery's state: the store enforces "expected matches current"
   * (§5); R5 legality is the state machine's owner, enforced by the core.
   * `stateReason` accompanies the transition (DeliveryUpdated carries
   * state + reason); an optional attempt commits in the same write (DEC-16
   * fan-out losers are recorded as superseded attempts).
   */
  transitionDelivery(
    deliveryId: DeliveryId,
    expectedState: DeliveryState,
    nextState: DeliveryState,
    stateReason?: DeliveryStateReason,
    attempt?: DeliveryAttempt,
  ): Promise<StoreResult<void>>;
  /** I6: the parent Delivery must exist. Attempts are append-only. */
  appendDeliveryAttempt(deliveryId: DeliveryId, attempt: DeliveryAttempt): Promise<StoreResult<AttemptId>>;

  // §7 recovery support (DEC-21)
  listPendingAcceptances(options?: PageOptions): Promise<StoreResult<PendingAcceptancePage>>;
  /** Idempotent: settling twice is fine; unknown messageId → RecordNotFound. */
  markEffectsSettled(messageId: MessageId): Promise<StoreResult<void>>;
  scanJournal(sinceSequence?: Sequence, limit?: number): Promise<StoreResult<JournalEntry[]>>;

  /** Release adapter resources (file handles). In-memory: no-op. */
  close(): Promise<void>;
}

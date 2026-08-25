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
  RecipientSnapshot,
  Sequence,
  Template,
  TemplateId,
  Thread,
  ThreadId,
} from "../schemas.js";
import type {
  AgentEndpointClaim,
  AgentEndpointClaimId,
  AgentId,
  AgentInboxItem,
  AgentInboxItemId,
} from "../../b3/contract/records.js";
import type {
  AcceptanceInput,
  AcceptanceOutcome,
  AgentEndpointClaimInput,
  AgentEndpointTransferInput,
  AgentEndpointTransferOutcome,
  JournalEntry,
  PageOptions,
  PendingAcceptancePage,
  PolicyPair,
  RoomThreadSpec,
  StoreResult,
  TemplatePageOut,
} from "./store-types.js";
export * from "./store-types.js";

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

  /**
   * B3c §12.5 — materialise a direct Thread BEFORE its first Message.
   *
   * Direct Threads have always been created implicitly inside
   * `commitAcceptance`, which is fine while every Thread starts with a send.
   * B3c's contract requires a `threadId` on the send itself, so a caller needs
   * a way to obtain one first. Get-or-create on the canonical sorted pair —
   * the same identity `commitAcceptance` uses, so the two paths converge on
   * one Thread rather than racing to create two.
   */
  createDirectThread(pair: [PersonId, PersonId]): Promise<StoreResult<Thread>>;

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

  // --- B3c §8.1: the durable Agent endpoint and inbox ------------------------
  //
  // These are separate seam operations rather than reuse of the generic
  // record writes because each one is a check-then-act that MUST be
  // indivisible: the generation CAS and the write have to happen inside the
  // same serialized stretch, or two Runtimes racing a continuation both
  // "win" and the Agent ends up with two live endpoints (§13.6).

  /**
   * Commit a claim, guarded by the generation the caller believes is current.
   * `expectedEndpointGeneration: -1` means "this Agent has no claim yet".
   * A mismatch is `RevisionConflict` and writes nothing.
   */
  commitAgentEndpointClaim(
    input: AgentEndpointClaimInput,
  ): Promise<StoreResult<AgentEndpointClaim>>;

  /**
   * Move the endpoint from one Run to the next and re-point the named inbox
   * items in ONE operation (§13.6: "Messaging endpoint claim transferred
   * atomically"). An item in `submitted-unconfirmed` may never be re-pointed:
   * its keystrokes already reached the old PTY, so redirecting it would
   * deliver the same Message twice. That is `StateConflict`, and the whole
   * transfer is refused rather than partially applied.
   */
  transferAgentEndpoint(
    input: AgentEndpointTransferInput,
  ): Promise<StoreResult<AgentEndpointTransferOutcome>>;

  /** Write one inbox item state (accept, claim, submit, fail). Journaled. */
  transitionAgentInboxItem(item: AgentInboxItem): Promise<StoreResult<AgentInboxItem>>;

  /**
   * One claim by id. The id is a digest of (agentId, generation) and so cannot
   * be reversed into an Agent — a caller holding only a claim id (which is all
   * `activateAgentEndpointClaim` receives) has no other way to reach it. The
   * alternative, remembering the mapping in process memory, would not survive
   * the hard restart §25-B3c requires queued Messages to survive.
   */
  getAgentEndpointClaim(
    claimId: AgentEndpointClaimId,
  ): Promise<StoreResult<AgentEndpointClaim | null>>;

  /** The Agent's current (non-closed) endpoint claim, or null. */
  getAgentEndpoint(agentId: AgentId): Promise<StoreResult<AgentEndpointClaim | null>>;
  /** Every claim for the Agent, oldest generation first — closed ones included. */
  listAgentEndpointClaims(agentId: AgentId): Promise<StoreResult<AgentEndpointClaim[]>>;
  /**
   * Every claim, for the one question that has no Agent to scope it: "which
   * Agent does this Run belong to?" An exact-run send names a Run and nothing
   * else, and the endpoint claim is the durable join between the two.
   */
  listAllAgentEndpointClaims(): Promise<StoreResult<AgentEndpointClaim[]>>;
  listAgentInbox(agentId: AgentId): Promise<StoreResult<AgentInboxItem[]>>;
  getAgentInboxItem(
    itemId: AgentInboxItemId,
  ): Promise<StoreResult<AgentInboxItem | null>>;

  /** Release adapter resources (file handles). In-memory: no-op. */
  close(): Promise<void>;
}

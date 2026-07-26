/**
 * store-shared — the single implementation of the store seam semantics.
 *
 * Both adapters wrap this core:
 *   - store-memory: the core alone (A4: test/harness only, no durability).
 *   - store-jsonl:  the core + a persistence hook (write-then-fsync per
 *     mutation, full rebuild by replaying the journal of ops on open).
 *
 * Plan §17 says "adapters never import each other" — this module is not an
 * adapter; it satisfies no seam alone (it has no persistence story). Sharing
 * it is what makes "both adapters satisfy the seam with identical semantics"
 * (S1-a requirement) true by construction rather than by discipline.
 *
 * Semantics implemented (Messaging-Store-Seam.md incl. §11 errata):
 *   §2  atomic commitAcceptance: direct-thread get-or-create on the canonical
 *       sorted pair; room thread must pre-exist; put-if-absent idempotency
 *       with requestHash comparison; global monotonic sequence; single commit
 *       of message + snapshot + deliveries + effectsPending marker + journal.
 *   §3  one global sequence; gaps permitted; opaque s_<n> cursors.
 *   §4  reads of committed state only; limit clamped to pageLimitMax.
 *   §5  CAS transitionDelivery (expected == current only — R5 legality is the
 *       core's job), append-only attempts, revision CAS on policy/template.
 *   §6  typed StoreError outcomes; persist-hook IO failure → StoreUnavailable.
 *   §7  listPendingAcceptances / markEffectsSettled / scanJournal.
 *   §11 journaled delivery/policy/template writes; inbox = non-terminal only;
 *       urgentDowngraded persisted on the AcceptanceRecord; createRoomThread
 *       (§11.4: get-or-create by room key, persisted in the op log, NOT
 *       journaled — no committed-fact event exists for Thread creation);
 *       listThreadsForPerson (§11.5: direct-for-person + all room Threads —
 *       membership filtering lives above the store); getSnapshot (§11.6: the
 *       frozen snapshot by messageId — I5 evidence; its original motivation,
 *       the sweep's R4 re-drive, was removed by §11.7); §11.7 blocked
 *       recipients commit TERMINAL failed{blocked-by-contact-policy} INSIDE
 *       commitAcceptance, each with a journaled DeliveryUpdated in the same
 *       transaction (MSG-016).
 *
 * Write serialization (Store-Seam §1 rule 3, F1): EVERY mutation runs through
 * a per-store mutation queue, so check-then-act (idempotency reservation,
 * thread get-or-create, CAS) and persist+apply are one indivisible stretch
 * per mutation. The jsonl persist hook yields between persist and apply —
 * without the queue two in-flight mutations interleave (double acceptance,
 * duplicate Thread, illegal delivered→failed journaled). Holds for BOTH
 * adapters by construction: the queue lives here, in the shared core.
 */

import {
  constants,
  cursorFor,
  idPatterns,
  schemaVersion,
} from "../public/contract/index.js";
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
} from "../public/contract/index.js";
import type { ClockIds } from "../seams/clock.js";
import type {
  AcceptanceInput,
  AcceptanceOutcome,
  JournalEntry,
  MessagingStore,
  PageOptions,
  PendingAcceptancePage,
  PolicyPair,
  RoomThreadSpec,
  StoreError,
  StoreResult,
  TemplatePageOut,
} from "../seams/store.js";

// --- durable ops: the unit of persistence and of jsonl replay -----------------

export type StoreOp =
  | {
      op: "acceptance";
      thread: Thread;
      message: Message;
      snapshot: RecipientSnapshot;
      deliveries: Delivery[];
      acceptance: AcceptanceRecord;
      /**
       * MessageCommitted first, then one DeliveryUpdated per §11.7
       * terminal-at-commit blocked Delivery (MSG-016 observability — the
       * failure is a committed fact, journaled in the same transaction).
       */
      journal: JournalEntry[];
    }
  | {
      op: "room-thread";
      thread: Thread;
    }
  | {
      op: "delivery-transition";
      delivery: Delivery;
      attempt?: DeliveryAttempt;
      journal: JournalEntry;
    }
  | { op: "attempt"; attempt: DeliveryAttempt }
  | {
      op: "policy";
      contact?: ContactPolicy;
      dnd?: DndPolicy;
      journal: JournalEntry;
    }
  | { op: "template"; template: Template; journal: JournalEntry }
  | { op: "settled"; messageId: MessageId };

export const storeOpNames = [
  "acceptance",
  "room-thread",
  "delivery-transition",
  "attempt",
  "policy",
  "template",
  "settled",
] as const;

/** Thrown when durable state is unparseable/inconsistent (§6 StoreCorrupt — halt, operator intervention). */
export class StoreException extends Error {
  readonly error: StoreError;
  constructor(error: StoreError) {
    super(`${error.name}: ${JSON.stringify(error)}`);
    this.error = error;
  }
}

export type PersistHook = (op: StoreOp) => Promise<void>;

export interface StoreState {
  threads: Map<string, Thread>;
  /** canonical sorted pair key -> ThreadId */
  directThreads: Map<string, ThreadId>;
  /** room key (`authority\nexternalId`) -> ThreadId (§11.4) */
  roomThreads: Map<string, ThreadId>;
  messages: Map<string, Message>;
  snapshots: Map<string, RecipientSnapshot>;
  deliveries: Map<string, Delivery>;
  attempts: Map<string, DeliveryAttempt>;
  /** `${senderId}\n${clientMessageId}` -> AcceptanceRecord */
  acceptances: Map<string, AcceptanceRecord>;
  contactPolicies: Map<string, ContactPolicy>;
  dndPolicies: Map<string, DndPolicy>;
  templates: Map<string, Template>;
  /** TemplateId -> sequence of its latest write (ordering for listTemplates). */
  templateOrder: Map<string, number>;
  journal: JournalEntry[];
  lastSequence: number;
}

export function emptyStoreState(): StoreState {
  return {
    threads: new Map(),
    directThreads: new Map(),
    roomThreads: new Map(),
    messages: new Map(),
    snapshots: new Map(),
    deliveries: new Map(),
    attempts: new Map(),
    acceptances: new Map(),
    contactPolicies: new Map(),
    dndPolicies: new Map(),
    templates: new Map(),
    templateOrder: new Map(),
    journal: [],
    lastSequence: 0,
  };
}

const ok = <T>(value: T): StoreResult<T> => ({ kind: "ok", value });
const failure = <T>(error: StoreError): StoreResult<T> => ({ kind: "error", error });
const recordNotFound = (record: string, id: string): StoreError => ({
  name: "RecordNotFound",
  record,
  id,
});

const canonicalPairKey = (a: string, b: string): string => [a, b].sort().join("\n");
const acceptanceKey = (senderId: string, clientMessageId: string): string =>
  `${senderId}\n${clientMessageId}`;
/** §11.4: the room key is the durable join to the owning capability (G2). */
const roomKey = (authority: string, externalId: string): string =>
  `${authority}\n${externalId}`;

const CURSOR_PATTERN = new RegExp(idPatterns.Cursor);
const CURSOR_PREFIX = "s_";

function parseCursor(cursor: Cursor): number | StoreError {
  if (!CURSOR_PATTERN.test(cursor)) {
    return { name: "CursorInvalid", cursor };
  }
  return Number(cursor.slice(CURSOR_PREFIX.length));
}

interface Page<T> {
  page: T[];
  nextCursor?: Cursor;
}

/** §3/§4: sequence-ascending pagination with clamped limit and opaque s_<n> cursors. */
function paginate<T>(
  sortedAscending: T[],
  sequenceOf: (item: T) => number,
  options: PageOptions | undefined,
): StoreResult<Page<T>> {
  let after = -1;
  if (options?.cursor !== undefined) {
    const parsed = parseCursor(options.cursor);
    if (typeof parsed !== "number") return failure(parsed);
    after = parsed;
  }
  const limit = Math.min(Math.max(options?.limit ?? constants.pageLimitMax, 1), constants.pageLimitMax);
  const eligible = sortedAscending.filter((item) => sequenceOf(item) > after);
  const page = eligible.slice(0, limit);
  const last = page[page.length - 1];
  const result: Page<T> = { page };
  if (eligible.length > limit && last !== undefined) {
    result.nextCursor = cursorFor(sequenceOf(last) as Sequence);
  }
  return ok(result);
}

export class StoreCore implements MessagingStore {
  readonly state: StoreState;
  protected readonly clock: ClockIds;
  private persist?: PersistHook;
  private onClose?: () => Promise<void>;
  /**
   * Store-Seam §1 rule 3 (F1): the per-store mutation queue. Every mutating
   * method body runs inside this chain so check-then-act + persist + apply is
   * indivisible with respect to other mutations — even though the persist
   * hook yields (the jsonl hook is sync write+fsync wrapped in a Promise, and
   * `await` always yields). Reads are unaffected (committed-state snapshots).
   */
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(clock: ClockIds, state: StoreState = emptyStoreState()) {
    this.clock = clock;
    this.state = state;
  }

  /** Run one mutation after every previously-queued mutation completes. */
  private runMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(mutation, mutation);
    // The tail never rejects — later mutations must not be skipped because an
    // earlier one returned a typed failure (mutations don't throw, but the
    // chain must not depend on that discipline).
    this.mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** store-jsonl attaches durability AFTER replaying existing ops. */
  attachPersistence(persist: PersistHook, onClose: () => Promise<void>): void {
    this.persist = persist;
    this.onClose = onClose;
  }

  async close(): Promise<void> {
    if (this.onClose) await this.onClose();
  }

  // --- sequence --------------------------------------------------------------

  private nextSequence(): Sequence {
    this.state.lastSequence += 1;
    return this.state.lastSequence as Sequence;
  }

  private observeSequence(sequence: number): void {
    if (sequence > this.state.lastSequence) this.state.lastSequence = sequence;
  }

  // --- op application (shared by live mutations and jsonl replay) ------------

  applyOp(op: StoreOp): void {
    switch (op.op) {
      case "acceptance": {
        this.state.threads.set(op.thread.id, op.thread);
        if (op.thread.threadKind === "direct" && op.thread.direct) {
          const [a, b] = op.thread.direct.pair;
          this.state.directThreads.set(canonicalPairKey(a, b), op.thread.id);
        }
        if (op.thread.room) {
          // Defensive: acceptance ops re-set their (pre-existing) room Thread
          // — keep the room-key index complete under replay either way.
          this.state.roomThreads.set(
            roomKey(op.thread.room.authority, op.thread.room.externalId),
            op.thread.id,
          );
        }
        this.state.messages.set(op.message.id, op.message);
        this.state.snapshots.set(op.snapshot.id, op.snapshot);
        for (const delivery of op.deliveries) {
          this.state.deliveries.set(delivery.id, delivery);
        }
        this.state.acceptances.set(
          acceptanceKey(op.acceptance.senderId, op.acceptance.clientMessageId),
          op.acceptance,
        );
        // Replay honesty: pre-§11.7 op logs carried a single journal entry
        // (MessageCommitted only); tolerate both shapes.
        const entries = Array.isArray(op.journal) ? op.journal : [op.journal];
        for (const entry of entries) {
          this.state.journal.push(entry);
          this.observeSequence(entry.sequence);
        }
        this.observeSequence(op.message.sequence);
        return;
      }
      case "room-thread": {
        // §11.4: persisted in the op log, NOT journaled — no committed-fact
        // event exists for Thread creation.
        this.state.threads.set(op.thread.id, op.thread);
        if (op.thread.room) {
          this.state.roomThreads.set(
            roomKey(op.thread.room.authority, op.thread.room.externalId),
            op.thread.id,
          );
        }
        return;
      }
      case "delivery-transition": {
        this.state.deliveries.set(op.delivery.id, op.delivery);
        if (op.attempt) this.state.attempts.set(op.attempt.id, op.attempt);
        this.state.journal.push(op.journal);
        this.observeSequence(op.journal.sequence);
        return;
      }
      case "attempt": {
        this.state.attempts.set(op.attempt.id, op.attempt);
        return;
      }
      case "policy": {
        if (op.contact) this.state.contactPolicies.set(op.contact.personId, op.contact);
        if (op.dnd) this.state.dndPolicies.set(op.dnd.personId, op.dnd);
        this.state.journal.push(op.journal);
        this.observeSequence(op.journal.sequence);
        return;
      }
      case "template": {
        this.state.templates.set(op.template.id, op.template);
        this.state.templateOrder.set(op.template.id, op.journal.sequence);
        this.state.journal.push(op.journal);
        this.observeSequence(op.journal.sequence);
        return;
      }
      case "settled": {
        for (const [key, acceptance] of this.state.acceptances) {
          if (acceptance.messageId === op.messageId) {
            this.state.acceptances.set(key, { ...acceptance, effectsPending: false });
          }
        }
        return;
      }
    }
  }

  /** Persist-then-apply: a crash between the two is recovered by replay on open. */
  private async persistAndApply(op: StoreOp): Promise<StoreError | undefined> {
    if (this.persist) {
      try {
        await this.persist(op);
      } catch (cause) {
        return {
          name: "StoreUnavailable",
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true,
        };
      }
    }
    this.applyOp(op);
    return undefined;
  }

  // --- §2 the acceptance transaction ------------------------------------------

  async commitAcceptance(input: AcceptanceInput): Promise<AcceptanceOutcome> {
    // §1 rule 3 / DEC-20 (F1): the whole transaction — thread get-or-create,
    // idempotency reservation, sequence assignment, persist+apply — is one
    // serialized stretch; a concurrent same-key or same-pair commit queues
    // behind this one and observes its committed state.
    return this.runMutation(() => this.commitAcceptanceSerialized(input));
  }

  private async commitAcceptanceSerialized(input: AcceptanceInput): Promise<AcceptanceOutcome> {
    // 1. Thread get-or-create (§2.1).
    let thread: Thread;
    if (input.thread.kind === "direct") {
      const pair = [...input.thread.pair].sort() as [PersonId, PersonId];
      const key = canonicalPairKey(pair[0], pair[1]);
      const existingId = this.state.directThreads.get(key);
      const existing = existingId !== undefined ? this.state.threads.get(existingId) : undefined;
      if (existing) {
        thread = existing;
      } else {
        thread = {
          id: this.clock.newId("thread"),
          kind: "thread",
          schemaVersion,
          createdAt: this.clock.now(),
          threadKind: "direct",
          direct: { pair },
        };
      }
    } else {
      const existing = this.state.threads.get(input.thread.threadId);
      if (!existing) {
        return { kind: "failed", error: recordNotFound("thread", input.thread.threadId) };
      }
      thread = existing;
    }

    // 2. Idempotency reservation (§2.2, A5).
    const { senderId, clientMessageId, requestHash } = input.idempotency;
    const key = acceptanceKey(senderId, clientMessageId);
    const prior = this.state.acceptances.get(key);
    if (prior) {
      if (prior.requestHash === requestHash) {
        return { kind: "duplicate", original: prior };
      }
      return {
        kind: "conflict",
        error: {
          name: "IdempotencyConflict",
          clientMessageId,
          originalMessageId: prior.messageId,
        },
      };
    }

    // 3. Sequence assignment (§2.3) — inside the transaction, by the adapter.
    const sequence = this.nextSequence();
    const message: Message = { ...input.message, threadId: thread.id, sequence };
    // §11.7 (R4 made literal): a recipient on the frozen snapshot's blocked
    // set commits TERMINAL failed{blocked-by-contact-policy} INSIDE this
    // transaction — the zero-transition shape of R5's
    // pending → failed{policy-blocked} ("Terminal AT ACCEPTANCE … no attempts
    // are ever made"). No pending instant is ever observable: pending-state
    // re-drives (presence-open, DND release, DEC-21 sweep) can never see,
    // hold, or deliver a blocked Delivery, and §11.2's inbox (non-terminal
    // only) never serves it — the commit→settle window carries no R4 hazard.
    const blockedRecipients = new Set(
      (input.snapshot.blocked ?? []).map((entry) => entry.personId),
    );
    const deliveries: Delivery[] = input.deliveries.map((delivery) => {
      const stamped: Delivery = { ...delivery, messageId: message.id, threadId: thread.id };
      if (!blockedRecipients.has(delivery.recipientId)) return stamped;
      return {
        ...stamped,
        state: "failed",
        stateReason: "blocked-by-contact-policy",
        updatedAt: this.clock.now(),
      };
    });
    const snapshot: RecipientSnapshot = { ...input.snapshot, messageId: message.id };
    const acceptance: AcceptanceRecord = {
      id: this.clock.newId("acceptance"),
      kind: "acceptance",
      schemaVersion,
      createdAt: this.clock.now(),
      senderId,
      clientMessageId,
      requestHash,
      messageId: message.id,
      threadId: thread.id,
      sequence,
      effectsPending: true, // §2.5 recovery marker, same transaction
      ...(input.urgentDowngraded !== undefined
        ? { urgentDowngraded: input.urgentDowngraded }
        : {}),
    };
    // §11.1/§11.7: MessageCommitted, then one journaled DeliveryUpdated per
    // blocked Delivery so the terminal failure stays an observable committed
    // fact (MSG-016) — same events the S2-a effect-leg CAS produced, now
    // inside the commit.
    const journal: JournalEntry[] = [{ sequence, kind: "MessageCommitted", message }];
    for (const delivery of deliveries) {
      if (delivery.state === "failed") {
        journal.push({
          sequence: this.nextSequence(),
          kind: "DeliveryUpdated",
          delivery,
        });
      }
    }

    // 4–5. Single commit: thread + message + snapshot + deliveries + marker + journal.
    const opError = await this.persistAndApply({
      op: "acceptance",
      thread,
      message,
      snapshot,
      deliveries,
      acceptance,
      journal,
    });
    if (opError) return { kind: "failed", error: opError };

    return {
      kind: "accepted",
      messageId: message.id,
      threadId: thread.id,
      sequence,
      ...(input.urgentDowngraded !== undefined
        ? { urgentDowngraded: input.urgentDowngraded }
        : {}),
    };
  }

  // --- §11.4 room Thread creation ------------------------------------------------

  /**
   * §11.4: get-or-create keyed by the room key — one Thread per room, forever.
   * The whole check-then-create runs inside the mutation queue (§1 rule 3), so
   * two concurrent creates produce exactly one Thread and the loser proceeds
   * against the existing one (not an error). The threadId is minted HERE via
   * the clock/ID seam — the caller never supplies it. Not journaled (no
   * committed-fact event); persisted in the op log by durable adapters.
   */
  async createRoomThread(room: RoomThreadSpec): Promise<StoreResult<Thread>> {
    return this.runMutation(() => this.createRoomThreadSerialized(room));
  }

  private async createRoomThreadSerialized(room: RoomThreadSpec): Promise<StoreResult<Thread>> {
    const key = roomKey(room.authority, room.externalId);
    const existingId = this.state.roomThreads.get(key);
    const existing = existingId !== undefined ? this.state.threads.get(existingId) : undefined;
    if (existing) return ok(existing);
    const thread: Thread = {
      id: this.clock.newId("thread"),
      kind: "thread",
      schemaVersion,
      createdAt: this.clock.now(),
      threadKind: room.threadKind,
      room: { authority: room.authority, externalId: room.externalId },
    };
    const opError = await this.persistAndApply({ op: "room-thread", thread });
    if (opError) return failure(opError);
    return ok(thread);
  }

  // --- §4 reads -----------------------------------------------------------------

  async getThread(threadId: ThreadId): Promise<StoreResult<Thread>> {
    const thread = this.state.threads.get(threadId);
    return thread ? ok(thread) : failure(recordNotFound("thread", threadId));
  }

  async getDirectThread(personA: PersonId, personB: PersonId): Promise<StoreResult<Thread>> {
    const threadId = this.state.directThreads.get(canonicalPairKey(personA, personB));
    const thread = threadId !== undefined ? this.state.threads.get(threadId) : undefined;
    return thread ? ok(thread) : failure(recordNotFound("thread", canonicalPairKey(personA, personB)));
  }

  async getMessage(messageId: MessageId): Promise<StoreResult<Message>> {
    const message = this.state.messages.get(messageId);
    return message ? ok(message) : failure(recordNotFound("message", messageId));
  }

  /**
   * §11.5: every DIRECT Thread whose pair contains personId, plus EVERY room
   * Thread. Room membership filtering is NOT the store's truth (DEC-04) — the
   * core filters through the membership seam at request time (R3). Map
   * insertion order = creation order (not contractual).
   */
  async listThreadsForPerson(personId: PersonId): Promise<StoreResult<Thread[]>> {
    const threads = [...this.state.threads.values()].filter((thread) => {
      if (thread.threadKind === "direct" && thread.direct) {
        return thread.direct.pair.includes(personId);
      }
      return thread.threadKind === "team" || thread.threadKind === "mission";
    });
    return ok(threads);
  }

  /**
   * A-R-N4-1: the unscoped lane enumeration for oversight.read holders —
   * every direct Thread (creation order, same Map-insertion note as §11.5).
   * Both adapters share this implementation: direct Threads are created
   * inside commitAcceptance, so they live in the same in-memory index the
   * §11.5 read uses (the jsonl adapter folds them from the op log at boot).
   */
  async listDirectThreads(): Promise<StoreResult<Thread[]>> {
    const threads = [...this.state.threads.values()].filter(
      (thread) => thread.threadKind === "direct" && thread.direct !== undefined,
    );
    return ok(threads);
  }

  /** §11.6: the frozen RecipientSnapshot by messageId (I5 evidence; the sweep no longer reads it — §11.7). */
  async getSnapshot(messageId: MessageId): Promise<StoreResult<RecipientSnapshot>> {
    const snapshot = [...this.state.snapshots.values()].find(
      (candidate) => candidate.messageId === messageId,
    );
    return snapshot ? ok(snapshot) : failure(recordNotFound("snapshot", messageId));
  }

  async getMessages(
    threadId: ThreadId,
    options?: PageOptions,
  ): Promise<StoreResult<{ messages: Message[]; nextCursor?: Cursor }>> {
    if (!this.state.threads.has(threadId)) {
      return failure(recordNotFound("thread", threadId));
    }
    const messages = [...this.state.messages.values()]
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.sequence - b.sequence);
    const result = paginate(messages, (message) => message.sequence, options);
    if (result.kind === "error") return result;
    const { page, nextCursor } = result.value;
    return ok(nextCursor !== undefined ? { messages: page, nextCursor } : { messages: page });
  }

  /** §11.2: non-terminal Deliveries only — pending | held; delivered/failed never appear. */
  async getInbox(
    personId: PersonId,
    options?: PageOptions,
  ): Promise<StoreResult<{ messages: Message[]; nextCursor?: Cursor }>> {
    const messages = [...this.state.deliveries.values()]
      .filter(
        (delivery) =>
          delivery.recipientId === personId &&
          (delivery.state === "pending" || delivery.state === "held"),
      )
      .map((delivery) => this.state.messages.get(delivery.messageId))
      .filter((message): message is Message => message !== undefined)
      .sort((a, b) => a.sequence - b.sequence);
    const result = paginate(messages, (message) => message.sequence, options);
    if (result.kind === "error") return result;
    const { page, nextCursor } = result.value;
    return ok(nextCursor !== undefined ? { messages: page, nextCursor } : { messages: page });
  }

  async getDeliveries(messageId: MessageId): Promise<StoreResult<Delivery[]>> {
    if (!this.state.messages.has(messageId)) {
      return failure(recordNotFound("message", messageId));
    }
    return ok(
      [...this.state.deliveries.values()].filter((delivery) => delivery.messageId === messageId),
    );
  }

  async findAcceptance(
    senderId: PersonId,
    clientMessageId: ClientMessageId,
  ): Promise<StoreResult<AcceptanceRecord>> {
    const acceptance = this.state.acceptances.get(acceptanceKey(senderId, clientMessageId));
    return acceptance
      ? ok(acceptance)
      : failure(recordNotFound("acceptance", acceptanceKey(senderId, clientMessageId)));
  }

  async getPolicy(personId: PersonId): Promise<StoreResult<PolicyPair>> {
    const contact = this.state.contactPolicies.get(personId);
    const dnd = this.state.dndPolicies.get(personId);
    if (!contact && !dnd) return failure(recordNotFound("policy", personId));
    return ok({ ...(contact ? { contact } : {}), ...(dnd ? { dnd } : {}) });
  }

  async getTemplate(templateId: TemplateId): Promise<StoreResult<Template>> {
    const template = this.state.templates.get(templateId);
    return template ? ok(template) : failure(recordNotFound("template", templateId));
  }

  async listTemplates(options?: PageOptions): Promise<StoreResult<TemplatePageOut>> {
    const templates = [...this.state.templates.values()].sort(
      (a, b) => (this.state.templateOrder.get(a.id) ?? 0) - (this.state.templateOrder.get(b.id) ?? 0),
    );
    const result = paginate(
      templates,
      (template) => this.state.templateOrder.get(template.id) ?? 0,
      options,
    );
    if (result.kind === "error") return result;
    const { page, nextCursor } = result.value;
    return ok(nextCursor !== undefined ? { templates: page, nextCursor } : { templates: page });
  }

  // --- §5 non-acceptance writes ---------------------------------------------------

  async putPolicy(
    personId: PersonId,
    policy: ContactPolicy | DndPolicy,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    return this.runMutation(() => this.putPolicySerialized(personId, policy, expectedRevision));
  }

  private async putPolicySerialized(
    personId: PersonId,
    policy: ContactPolicy | DndPolicy,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    const isContact = policy.kind === "contact-policy";
    const existing = isContact
      ? this.state.contactPolicies.get(personId)
      : this.state.dndPolicies.get(personId);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
      return failure({
        name: "RevisionConflict",
        expected: expectedRevision,
        actual: existing?.revision ?? 0,
      });
    }
    const journal: JournalEntry = {
      sequence: this.nextSequence(),
      kind: "PolicyChanged",
      personId,
      policy: isContact ? "contact" : "dnd",
      revision: policy.revision,
    };
    const opError = await this.persistAndApply(
      isContact
        ? { op: "policy", contact: policy as ContactPolicy, journal }
        : { op: "policy", dnd: policy as DndPolicy, journal },
    );
    if (opError) return failure(opError);
    return ok({ revision: policy.revision });
  }

  async putTemplate(
    template: Template,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    return this.runMutation(() => this.putTemplateSerialized(template, expectedRevision));
  }

  private async putTemplateSerialized(
    template: Template,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    const existing = this.state.templates.get(template.id);
    if (expectedRevision !== undefined && existing?.revision !== expectedRevision) {
      return failure({
        name: "RevisionConflict",
        expected: expectedRevision,
        actual: existing?.revision ?? 0,
      });
    }
    const journal: JournalEntry = {
      sequence: this.nextSequence(),
      kind: "TemplateWritten",
      template,
    };
    const opError = await this.persistAndApply({ op: "template", template, journal });
    if (opError) return failure(opError);
    return ok({ revision: template.revision });
  }

  async retireTemplate(
    templateId: TemplateId,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    return this.runMutation(() => this.retireTemplateSerialized(templateId, expectedRevision));
  }

  private async retireTemplateSerialized(
    templateId: TemplateId,
    expectedRevision?: number,
  ): Promise<StoreResult<{ revision: number }>> {
    const existing = this.state.templates.get(templateId);
    if (!existing) return failure(recordNotFound("template", templateId));
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      return failure({
        name: "RevisionConflict",
        expected: expectedRevision,
        actual: existing.revision,
      });
    }
    const retired: Template = { ...existing, retired: true, revision: existing.revision + 1 };
    const journal: JournalEntry = {
      sequence: this.nextSequence(),
      kind: "TemplateWritten",
      template: retired,
    };
    const opError = await this.persistAndApply({ op: "template", template: retired, journal });
    if (opError) return failure(opError);
    return ok({ revision: retired.revision });
  }

  /**
   * §5 CAS: the store enforces "expected matches current" only — R5 legality
   * is owned by the state machine, enforced by the core above the seam.
   * The DEC-16 fan-out race resolves here: first transition wins; late ones
   * get StateConflict. Journaled per §11.1.
   */
  async transitionDelivery(
    deliveryId: DeliveryId,
    expectedState: DeliveryState,
    nextState: DeliveryState,
    stateReason?: DeliveryStateReason,
    attempt?: DeliveryAttempt,
  ): Promise<StoreResult<void>> {
    // §1 rule 3 (F1): the CAS check and the journaled persist+apply are one
    // serialized stretch — a concurrent CAS queues behind and observes the
    // winner's state (first transition wins; late ones get StateConflict).
    return this.runMutation(() =>
      this.transitionDeliverySerialized(deliveryId, expectedState, nextState, stateReason, attempt),
    );
  }

  private async transitionDeliverySerialized(
    deliveryId: DeliveryId,
    expectedState: DeliveryState,
    nextState: DeliveryState,
    stateReason?: DeliveryStateReason,
    attempt?: DeliveryAttempt,
  ): Promise<StoreResult<void>> {
    const current = this.state.deliveries.get(deliveryId);
    if (!current) return failure(recordNotFound("delivery", deliveryId));
    if (current.state !== expectedState) {
      return failure({
        name: "StateConflict",
        deliveryId,
        expected: expectedState,
        actual: current.state,
      });
    }
    const updated: Delivery = {
      ...current,
      state: nextState,
      updatedAt: this.clock.now(),
      ...(stateReason !== undefined ? { stateReason } : {}),
    };
    const journal: JournalEntry = {
      sequence: this.nextSequence(),
      kind: "DeliveryUpdated",
      delivery: updated,
    };
    const opError = await this.persistAndApply({
      op: "delivery-transition",
      delivery: updated,
      ...(attempt !== undefined ? { attempt: { ...attempt, deliveryId } } : {}),
      journal,
    });
    if (opError) return failure(opError);
    return ok(undefined);
  }

  /** I6: append-only; the parent Delivery must exist. Not journaled — no state change, no committed-fact event (§11.1). */
  async appendDeliveryAttempt(
    deliveryId: DeliveryId,
    attempt: DeliveryAttempt,
  ): Promise<StoreResult<AttemptId>> {
    return this.runMutation(() => this.appendDeliveryAttemptSerialized(deliveryId, attempt));
  }

  private async appendDeliveryAttemptSerialized(
    deliveryId: DeliveryId,
    attempt: DeliveryAttempt,
  ): Promise<StoreResult<AttemptId>> {
    if (!this.state.deliveries.has(deliveryId)) {
      return failure(recordNotFound("delivery", deliveryId));
    }
    const stamped: DeliveryAttempt = { ...attempt, deliveryId };
    const opError = await this.persistAndApply({ op: "attempt", attempt: stamped });
    if (opError) return failure(opError);
    return ok(stamped.id);
  }

  // --- §7 recovery support (DEC-21) ---------------------------------------------

  async listPendingAcceptances(options?: PageOptions): Promise<StoreResult<PendingAcceptancePage>> {
    const pending = [...this.state.acceptances.values()]
      .filter((acceptance) => acceptance.effectsPending)
      .sort((a, b) => a.sequence - b.sequence);
    const result = paginate(pending, (acceptance) => acceptance.sequence, options);
    if (result.kind === "error") return result;
    const { page, nextCursor } = result.value;
    return ok(nextCursor !== undefined ? { acceptances: page, nextCursor } : { acceptances: page });
  }

  async markEffectsSettled(messageId: MessageId): Promise<StoreResult<void>> {
    return this.runMutation(() => this.markEffectsSettledSerialized(messageId));
  }

  private async markEffectsSettledSerialized(messageId: MessageId): Promise<StoreResult<void>> {
    const acceptance = [...this.state.acceptances.values()].find(
      (candidate) => candidate.messageId === messageId,
    );
    if (!acceptance) return failure(recordNotFound("acceptance", messageId));
    if (!acceptance.effectsPending) return ok(undefined); // idempotent
    const opError = await this.persistAndApply({ op: "settled", messageId });
    if (opError) return failure(opError);
    return ok(undefined);
  }

  async scanJournal(sinceSequence?: Sequence, limit?: number): Promise<StoreResult<JournalEntry[]>> {
    const since = sinceSequence ?? (0 as Sequence);
    const capped = Math.min(Math.max(limit ?? constants.pageLimitMax, 1), constants.pageLimitMax);
    return ok(this.state.journal.filter((entry) => entry.sequence > since).slice(0, capped));
  }
}

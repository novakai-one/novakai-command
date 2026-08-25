/**
 * Queries — the 9 contract queries, through the store seam, under the R3
 * authorization matrix.
 *
 * Implemented: GetThread, ListThreadsForPerson, GetMessages, GetInbox,
 * GetDelivery, GetPolicy, ListTemplates (S4), GetPresence, GetCapabilities
 * (the latter lives on the composition root — it is pre-authentication
 * discovery).
 *
 * R3 matrix: member-scoped reads distinguish NotAuthorized (exists, not
 * yours) from Unknown* (does not exist) — the accepted existence
 * side-channel (Schemas §5). Room-Thread reads resolve membership through
 * the membership seam (Seams §3.1 isMember) at REQUEST time (R3: "current
 * member"): a known non-member → NotAuthorized; a room unknown to the
 * authority → UnknownThread (§3.3's shared public mapping); membership
 * unavailable → DependencyUnavailable{membership, retryable: true} — never a
 * silent allow or deny (G6).
 *
 * ListThreadsForPerson (Store-Seam §11.5): the store returns the person's
 * direct Threads plus ALL room Threads; the core filters rooms through
 * isMember — membership-unavailable fails the whole query loudly (G6); a
 * room unknown to the authority is omitted (the authority owns membership
 * truth — unknown room ⇒ cannot be a member).
 *
 * A-R-N4-1 (contract 1.1.0, oversight.read): the holder READS any direct
 * Thread regardless of pair membership — assertThreadMember's direct branch
 * admits the grant (rooms unchanged). A holder listing SELF gets the
 * interleaved §11.5 list PLUS the foreign lanes appended (non-holder output
 * is byte-identical to the pre-amendment order; ordering remains
 * non-contractual per §11.5); policy.admin acting for ANOTHER keeps the
 * pair-scoped read — oversight is a self-list privilege, never a leak of
 * unrelated lanes. READ-ONLY: the R4 party-only send rules are untouched.
 *
 * GetPolicy has no NotFound in its error list, so an absent policy pair
 * returns the DEC-14 synthesized defaults (view-only, revision 0 — never
 * persisted; the first real write starts at revision 1).
 *
 * ListTemplates (S4): any authenticated principal (R3). The frozen seam read
 * (Store-Seam §4 listTemplates) has no retired-awareness, so the
 * includeRetired filter lives HERE — the core paginates through the store
 * stream until it satisfies the limit or the stream ends, so a filtered page
 * never silently drops below the limit while more visible templates exist.
 * The limit is a HARD bound (audit F3): an omitted limit is clamped to
 * constants.pageLimitMax exactly like the other paged queries (one bounded
 * page, never a store drain), and each store read requests only the
 * remaining capacity, so a filtered page can never overshoot the limit.
 */

import { constants, contractVersion, schemaVersion } from "../contract/schemas.js";
import { MessagingError } from "../contract/schemas.js";
import type {
  CapabilityViewFeatures,
  ContactPolicy,
  Cursor,
  DndPolicy,
  PersonId,
  PolicyId,
  Template,
  Thread,
  Timestamp,
} from "../contract/schemas.js";
import type {
  DeliveryListResult,
  GetDeliveryInput,
  GetInboxInput,
  GetMessagesInput,
  GetPolicyInput,
  GetPresenceInput,
  GetThreadInput,
  ListTemplatesInput,
  ListThreadsForPersonInput,
  MessagePage,
  PolicyView,
  PresenceListResult,
  TemplatePage,
  ThreadListResult,
  ThreadView,
} from "../contract/schemas.js";
import type { Principal } from "../contract/ports/authority.js";
import type { MembershipSource } from "../contract/ports/membership.js";
import type { MessagingStore, StoreError } from "../contract/ports/store.js";
import type { ClockIds } from "../contract/ports/clock.js";
import type { PresenceRegistry } from "./presenceRegistry.js";
import { cursorInvalidError, storeDependencyError } from "./storeErrors.js";

export interface QueriesDeps {
  store: MessagingStore;
  clock: ClockIds;
  registry: PresenceRegistry;
  membership: MembershipSource;
}

function notAuthorized(detail: string): MessagingError {
  return new MessagingError("NotAuthorized", {
    message: detail,
    retryable: false,
    fields: {},
  });
}

function adminRequired(): MessagingError {
  return new MessagingError("NotAuthorized", {
    message: "acting for another Person requires policy.admin (R3)",
    retryable: false,
    fields: { requiredGrant: "policy.admin" },
  });
}

function unknownThread(threadId: string): MessagingError {
  return new MessagingError("UnknownThread", {
    message: `no such Thread: ${threadId}`,
    retryable: false,
    fields: { threadId },
  });
}

/** Store read failure → public error. RecordNotFound maps per context via onNotFound. */
function mapReadError(error: StoreError, onNotFound: () => MessagingError): MessagingError {
  if (error.name === "RecordNotFound") return onNotFound();
  if (error.name === "CursorInvalid") return cursorInvalidError(error.cursor as Cursor);
  return storeDependencyError(error);
}

export function createQueries(deps: QueriesDeps) {
  const { store, clock, registry, membership } = deps;

  /**
   * R3 member check for a resolved Thread. Throws NotAuthorized / UnknownThread /
   * DependencyUnavailable. Room Threads resolve membership through the seam at
   * REQUEST time (R3: current member) — never a cached roster.
   */
  async function assertThreadMember(principal: Principal, thread: Thread): Promise<void> {
    if (thread.threadKind === "direct" && thread.direct) {
      const [a, b] = thread.direct.pair;
      if (principal.personId === a || principal.personId === b) return;
      // A-R-N4-1: the oversight.read holder READS any direct lane (read-only).
      if (principal.grants.includes("oversight.read")) return;
      throw notAuthorized(`not a member of direct Thread ${thread.id} (R3)`);
    }
    if (!thread.room) {
      // Contract: room payload present iff threadKind team|mission — halt-class.
      throw storeDependencyError({
        name: "StoreCorrupt",
        message: `room Thread ${thread.id} is missing its room payload`,
      });
    }
    const outcome = await membership.isMember(thread.room, principal.personId);
    if (outcome.kind === "known") {
      if (outcome.member) return;
      throw notAuthorized(`not a current member of room Thread ${thread.id} (R3)`);
    }
    if (outcome.kind === "unknown") throw unknownThread(thread.id); // §3.3 shared mapping
    throw outcome.error; // DependencyUnavailable{membership, retryable: true} — never silent (G6)
  }

  function selfOrAdmin(principal: Principal, personId: PersonId | undefined): PersonId {
    const target = personId ?? principal.personId;
    if (target !== principal.personId && !principal.grants.includes("policy.admin")) {
      throw adminRequired();
    }
    return target;
  }

  async function getThread(principal: Principal, input: GetThreadInput): Promise<ThreadView> {
    const found = await store.getThread(input.threadId);
    if (found.kind === "error") throw mapReadError(found.error, () => unknownThread(input.threadId));
    await assertThreadMember(principal, found.value);
    return found.value;
  }

  async function listThreadsForPerson(
    principal: Principal,
    input: ListThreadsForPersonInput,
  ): Promise<ThreadListResult> {
    const target = selfOrAdmin(principal, input.personId);
    const listed = await store.listThreadsForPerson(target);
    if (listed.kind === "error") throw mapReadError(listed.error, () => unknownThread(target));
    const visible: Thread[] = [];
    for (const thread of listed.value) {
      if (thread.threadKind === "direct") {
        visible.push(thread); // the store already matched the pair (§11.5)
        continue;
      }
      if (!thread.room) {
        throw storeDependencyError({
          name: "StoreCorrupt",
          message: `room Thread ${thread.id} is missing its room payload`,
        });
      }
      // R3: room visibility = current membership, resolved at request time.
      const outcome = await membership.isMember(thread.room, target);
      if (outcome.kind === "known") {
        if (outcome.member) visible.push(thread);
        continue;
      }
      // The authority owns membership truth: an unknown room cannot have the
      // target as a member — omit. Unavailable fails the whole query (G6).
      if (outcome.kind === "unknown") continue;
      throw outcome.error;
    }
    // A-R-N4-1 (F1): a holder listing SELF gets every direct lane — the
    // FOREIGN half appended after the interleaved §11.5 list, so non-holder
    // output stays byte-identical to the pre-amendment order (ordering
    // remains non-contractual per §11.5 either way).
    if (target === principal.personId && principal.grants.includes("oversight.read")) {
      const lanes = await store.listDirectThreads();
      if (lanes.kind === "error") {
        // L9 (F2): this read folds/filters — it never resolves a record, so
        // there is no honest Unknown* mapping. CursorInvalid → ValidationFailed.
        if (lanes.error.name === "CursorInvalid") throw cursorInvalidError(lanes.error.cursor as Cursor);
        throw storeDependencyError(lanes.error);
      }
      const held = new Set(visible.map((thread) => thread.id));
      for (const lane of lanes.value) {
        if (!held.has(lane.id)) visible.push(lane);
      }
    }
    return { threads: visible };
  }

  async function getMessages(principal: Principal, input: GetMessagesInput): Promise<MessagePage> {
    const thread = await store.getThread(input.threadId);
    if (thread.kind === "error") throw mapReadError(thread.error, () => unknownThread(input.threadId));
    await assertThreadMember(principal, thread.value);
    const page = await store.getMessages(input.threadId, {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    if (page.kind === "error") throw mapReadError(page.error, () => unknownThread(input.threadId));
    return page.value;
  }

  async function getInbox(principal: Principal, input: GetInboxInput): Promise<MessagePage> {
    const target = selfOrAdmin(principal, input.personId);
    const page = await store.getInbox(target, {
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    if (page.kind === "error") {
      // L9: the §11.2 inbox read has no RecordNotFound path (it filters, it
      // never resolves a record) — a RecordNotFound here would be a store
      // bug, so there is no honest Unknown* mapping (the old UnknownThread
      // label was nonsense: the id is a personId). CursorInvalid maps to
      // ValidationFailed; everything else is dependency-or-core-bug.
      if (page.error.name === "CursorInvalid") throw cursorInvalidError(page.error.cursor as Cursor);
      throw storeDependencyError(page.error);
    }
    return page.value;
  }

  async function getDelivery(
    principal: Principal,
    input: GetDeliveryInput,
  ): Promise<DeliveryListResult> {
    const message = await store.getMessage(input.messageId);
    if (message.kind === "error") {
      throw mapReadError(
        message.error,
        () =>
          new MessagingError("UnknownMessage", {
            message: `no such Message: ${input.messageId}`,
            retryable: false,
            fields: { messageId: input.messageId },
          }),
      );
    }
    const thread = await store.getThread(message.value.threadId);
    if (thread.kind === "error") throw mapReadError(thread.error, () => unknownThread(message.value.threadId));
    await assertThreadMember(principal, thread.value);
    const deliveries = await store.getDeliveries(input.messageId);
    if (deliveries.kind === "error") throw mapReadError(deliveries.error, () => unknownThread(input.messageId));
    return { deliveries: deliveries.value };
  }

  async function getPolicy(principal: Principal, input: GetPolicyInput): Promise<PolicyView> {
    const target = selfOrAdmin(principal, input.personId);
    const found = await store.getPolicy(target);
    if (found.kind === "error" && found.error.name !== "RecordNotFound") {
      throw mapReadError(found.error, () => unknownThread(target));
    }
    const now: Timestamp = clock.now();
    // DEC-14 synthesized defaults (view-only; see header). revision 0 marks
    // "no persisted policy" — the first real write starts at revision 1.
    const contact: ContactPolicy =
      (found.kind === "ok" ? found.value.contact : undefined) ?? {
        id: "contactpolicy_default" as PolicyId,
        kind: "contact-policy",
        schemaVersion,
        createdAt: now,
        personId: target,
        allowlist: [],
        defaultRule: "deny",
        revision: 0,
      };
    const dnd: DndPolicy =
      (found.kind === "ok" ? found.value.dnd : undefined) ?? {
        id: "dndpolicy_default" as PolicyId,
        kind: "dnd-policy",
        schemaVersion,
        createdAt: now,
        personId: target,
        enabled: false,
        revision: 0,
      };
    return { contact, dnd };
  }

  async function getPresence(
    _principal: Principal,
    input: GetPresenceInput,
  ): Promise<PresenceListResult> {
    // Any authenticated principal (R3) — presence is observability, not addressing.
    return { presences: registry.presencesFor(input.personId) };
  }

  async function listTemplates(
    _principal: Principal, // any authenticated principal (R3)
    input: ListTemplatesInput,
  ): Promise<TemplatePage> {
    const includeRetired = input.includeRetired ?? false;
    // The §4 seam read has no retired-awareness — the includeRetired filter
    // is contract policy and lives HERE. With the filter on, paginate through
    // the store stream until the limit is satisfied or the stream ends.
    // Audit F3: the limit is a HARD bound — clamped to pageLimitMax like the
    // other paged queries (an omitted limit is one bounded page, never a
    // store drain), and each store read requests only the remaining capacity,
    // so a filtered page can never overshoot the limit. Because the store
    // page never exceeds the remaining capacity, every visible template in a
    // page is returned, so the store's nextCursor always points past the last
    // RETURNED template — no loss, no duplication.
    const wanted = Math.min(
      Math.max(input.limit ?? constants.pageLimitMax, 1),
      constants.pageLimitMax,
    );
    const templates: Template[] = [];
    let cursor = input.cursor;
    let nextCursor: Cursor | undefined;
    for (;;) {
      const page = await store.listTemplates({
        ...(cursor !== undefined ? { cursor } : {}),
        limit: wanted - templates.length,
      });
      if (page.kind === "error") {
        // As getInbox (L9): this read filters, it never resolves a record —
        // no honest Unknown* mapping exists. CursorInvalid → ValidationFailed.
        if (page.error.name === "CursorInvalid") throw cursorInvalidError(page.error.cursor as Cursor);
        throw storeDependencyError(page.error);
      }
      for (const template of page.value.templates) {
        if (includeRetired || !template.retired) templates.push(template);
      }
      nextCursor = page.value.nextCursor;
      if (nextCursor === undefined || templates.length >= wanted) break;
      cursor = nextCursor;
    }
    return { templates, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  return { getThread, listThreadsForPerson, getMessages, getInbox, getDelivery, getPolicy, getPresence, listTemplates };
}

export type Queries = ReturnType<typeof createQueries>;

/** GetCapabilities: discovery, pre-authentication; limits copied from constants — never hand-written. */
export function capabilityView(protocolVersion: string) {
  return {
    // L4/law-#3: the version comes from the contract source (generated.ts),
    // never a hand-copied literal.
    contractVersion,
    protocolVersion,
    // The full v1 surface (S4 sealed): the direct lane + rooms
    // (membership-resolved sends, frozen snapshots, room read authorization)
    // + attention mechanics (DND hold/release, urgent + override, contact
    // policy) + the Subscribe stream (R1, MSG-023) + templates (DEC-15).
    features: ["direct", "rooms", "attention", "subscribe", "templates"] as CapabilityViewFeatures[],
    limits: {
      messageMaxBytes: constants.messageMaxBytes,
      pageLimitMax: constants.pageLimitMax,
      subscriptionBufferMax: constants.subscriptionBufferMax,
    },
  };
}

/**
 * Queries — the S1 subset of the 9 contract queries, through the store seam,
 * under the R3 authorization matrix.
 *
 * Implemented: GetThread, GetMessages, GetInbox, GetDelivery, GetPolicy,
 * GetPresence, GetCapabilities (the latter lives on the composition root —
 * it is pre-authentication discovery).
 *
 * Deliberately ABSENT (not stubbed):
 *   - ListThreadsForPerson: the frozen store seam (§4) has no per-person
 *     thread listing read, and inbox/history reads cannot reconstruct one
 *     faithfully (terminal-delivery and sender-side threads would vanish).
 *     Lands with rooms in S2 when the seam read exists.
 *   - ListTemplates: templates are slice S4.
 *
 * R3 matrix: member-scoped reads distinguish NotAuthorized (exists, not
 * yours) from Unknown* (does not exist) — the accepted existence
 * side-channel (Schemas §5). Room-Thread reads require the membership seam
 * (S2); unwired in S1 → NotAuthorized, never a silent allow.
 *
 * GetPolicy has no NotFound in its error list, so an absent policy pair
 * returns the DEC-14 synthesized defaults (view-only, revision 0 — never
 * persisted; the first real write starts at revision 1).
 */

import { constants, contractVersion, schemaVersion } from "../public/contract/index.js";
import { MessagingError } from "../public/contract/index.js";
import type {
  ContactPolicy,
  Cursor,
  DndPolicy,
  PersonId,
  PolicyId,
  Thread,
  Timestamp,
} from "../public/contract/index.js";
import type {
  DeliveryListResult,
  GetDeliveryInput,
  GetInboxInput,
  GetMessagesInput,
  GetPolicyInput,
  GetPresenceInput,
  GetThreadInput,
  MessagePage,
  PolicyView,
  PresenceListResult,
  ThreadView,
} from "../public/contract/index.js";
import type { Principal } from "../seams/authority.js";
import type { MessagingStore, StoreError } from "../seams/store.js";
import type { ClockIds } from "../seams/clock.js";
import type { PresenceRegistry } from "./presenceRegistry.js";
import { cursorInvalidError, storeDependencyError } from "./storeErrors.js";

export interface QueriesDeps {
  store: MessagingStore;
  clock: ClockIds;
  registry: PresenceRegistry;
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
  const { store, clock, registry } = deps;

  /** R3 member check for a resolved Thread. Throws NotAuthorized. */
  function assertThreadMember(principal: Principal, thread: Thread): void {
    if (thread.threadKind === "direct" && thread.direct) {
      const [a, b] = thread.direct.pair;
      if (principal.personId === a || principal.personId === b) return;
      throw notAuthorized(`not a member of direct Thread ${thread.id} (R3)`);
    }
    // Room Threads: read-time membership resolves through the membership seam
    // (R3/R8) — slice S2, unwired in S1. Never a silent allow (G6).
    throw notAuthorized(`room Thread ${thread.id} reads require the membership seam (S2)`);
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
    assertThreadMember(principal, found.value);
    return found.value;
  }

  async function getMessages(principal: Principal, input: GetMessagesInput): Promise<MessagePage> {
    const thread = await store.getThread(input.threadId);
    if (thread.kind === "error") throw mapReadError(thread.error, () => unknownThread(input.threadId));
    assertThreadMember(principal, thread.value);
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
    assertThreadMember(principal, thread.value);
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

  return { getThread, getMessages, getInbox, getDelivery, getPolicy, getPresence };
}

export type Queries = ReturnType<typeof createQueries>;

/** GetCapabilities: discovery, pre-authentication; limits copied from constants — never hand-written. */
export function capabilityView(protocolVersion: string) {
  return {
    // L4/law-#3: the version comes from the contract source (generated.ts),
    // never a hand-copied literal.
    contractVersion,
    protocolVersion,
    // S1-c surface: the direct lane + attention mechanics (DND hold/release,
    // urgent + override, contact policy) + the Subscribe stream (R1, MSG-023).
    // Rooms (S2) and templates (S4) are absent, not hidden.
    features: ["direct", "attention", "subscribe"] as ("direct" | "attention" | "subscribe")[],
    limits: {
      messageMaxBytes: constants.messageMaxBytes,
      pageLimitMax: constants.pageLimitMax,
      subscriptionBufferMax: constants.subscriptionBufferMax,
    },
  };
}

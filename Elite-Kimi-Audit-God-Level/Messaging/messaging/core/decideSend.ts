/**
 * decideSend — THE single decision point for send-path policy (project law:
 * all send-path policy decisions happen in this ONE module; callers never
 * reproduce policy).
 *
 * Input: the authenticated Principal + a door-parsed SendMessageInput (+ its
 * A5 requestHash). Output: a fully-resolved AcceptanceInput for the store's
 * atomic commitAcceptance (DEC-20), or a typed rejection. decideSend performs
 * NO writes and NO transport effects — it reads policy/thread/provisioning
 * truth across the seams and decides.
 *
 * Policy owned here (frozen contracts):
 *  - Address resolution (Plan §8): person: → the canonical direct Thread pair
 *    (DEC-03); thread: → existing Thread, DIRECT only in S1 (rooms are S2).
 *  - UnknownRecipient (MSG-014): the address must resolve to a provisioned
 *    Person (provisioning directory at the authority trust boundary).
 *  - ContactPolicy (DEC-14, A3, R4): per-recipient send right. A3's most
 *    literal reading: an absent ContactPolicy record ≡ the DEC-14 default
 *    {allowlist: [], defaultRule: "deny"} — deny-by-default is preserved and
 *    provisioning grants addressability, NOT send-right. Implied-allow: the
 *    allowlist, defaultRule "allow", or SHARING a Thread with the recipient.
 *    The self-send lane (me, me) is always allowed (Plan §8). Direct-send
 *    blocking rejects the whole send with BlockedByContactPolicy (R4).
 *  - Urgent vs DND (DEC-07, MSG-010, W1): priority "urgent" against a
 *    DND-enabled recipient without the priority.override grant downgrades with
 *    a typed outcome — urgentDowngraded is computed HERE and persisted on the
 *    AcceptanceRecord (Store-Seam §11.3) so idempotent retries keep it.
 *  - Message size (R13): serialized Message JSON must not exceed
 *    constants.messageMaxBytes → ValidationFailed.
 *
 * S1 scope: template handling is NOT here — SendMessageInput carries no
 * template ref (only SendFromTemplate does, and templates are slice S4). The
 * R12 allowlist is enforced at UpsertTemplate when that slice lands.
 */

import { constants, schemaVersion } from "../public/contract/index.js";
import { MessagingError } from "../public/contract/index.js";
import type {
  ClientMessageId,
  ContactPolicy,
  Delivery,
  Message,
  PersonId,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  Thread,
  ThreadId,
} from "../public/contract/index.js";
import type { SendMessageInput } from "../public/contract/index.js";
import type { ClockIds } from "../seams/clock.js";
import type { Principal, ProvisioningDirectory } from "../seams/authority.js";
import type { AcceptanceInput, MessagingStore } from "../seams/store.js";
import { storeDependencyError } from "./storeErrors.js";

export interface DecideSendDeps {
  store: MessagingStore;
  clock: ClockIds;
  provisioning: ProvisioningDirectory;
}

export type SendDecision =
  | { kind: "accept"; input: AcceptanceInput; message: Message; deliveries: Delivery[] }
  | { kind: "reject"; error: MessagingError };

/** The DEC-14 default applied when a recipient has no ContactPolicy record (A3). */
export const DEFAULT_CONTACT_POLICY: Pick<ContactPolicy, "allowlist" | "defaultRule"> = {
  allowlist: [],
  defaultRule: "deny",
};

/**
 * Worst-case envelope placeholders for the R13 size check: the store stamps
 * threadId/sequence inside the transaction (DEC-19/20), so the check
 * serializes with a full-length thread id and a maximal sequence rather than
 * the pre-commit values — a few bytes conservative, never under-counting.
 */
const SIZE_CHECK_THREAD_ID = `thread_${"0".repeat(32)}` as ThreadId;
const SIZE_CHECK_SEQUENCE = Number.MAX_SAFE_INTEGER as Sequence;

interface AddressResolution {
  recipientId: PersonId;
  /** The direct pair for the store's get-or-create (DEC-03 canonicalisation). */
  pair: [PersonId, PersonId];
  /** Present when addressed by thread: ID (thread already exists). */
  existingThread?: Thread;
}

function parseAddress(address: SendMessageInput["address"]): { kind: "person" | "thread"; id: string } {
  const separator = address.indexOf(":");
  return { kind: address.slice(0, separator) as "person" | "thread", id: address.slice(separator + 1) };
}

async function resolveAddress(
  deps: DecideSendDeps,
  senderId: PersonId,
  input: SendMessageInput,
): Promise<AddressResolution | MessagingError> {
  const address = parseAddress(input.address);
  if (address.kind === "person") {
    const recipientId = address.id as PersonId;
    if (recipientId !== senderId && !(await deps.provisioning.isProvisioned(recipientId))) {
      return new MessagingError("UnknownRecipient", {
        message: `address does not resolve to a provisioned Person: ${input.address}`,
        retryable: false,
        fields: { address: input.address },
      });
    }
    return { recipientId, pair: [senderId, recipientId] };
  }
  // thread: address (R4): DIRECT Threads only in S1 — the sender must be one
  // of the canonical pair; the recipient is the other member.
  const threadId = address.id as ThreadId;
  const found = await deps.store.getThread(threadId);
  if (found.kind === "error") {
    if (found.error.name === "RecordNotFound") {
      return new MessagingError("UnknownThread", {
        message: `no such Thread: ${threadId}`,
        retryable: false,
        fields: { threadId },
      });
    }
    return storeDependencyError(found.error);
  }
  const thread = found.value;
  if (thread.threadKind !== "direct" || !thread.direct) {
    // Room Threads require the membership seam (R8) — slice S2, not wired in S1.
    return new MessagingError("NotAuthorized", {
      message: `Thread ${threadId} is a room Thread; room sends require the membership seam (S2)`,
      retryable: false,
      fields: {},
    });
  }
  const [a, b] = thread.direct.pair;
  if (senderId !== a && senderId !== b) {
    return new MessagingError("NotAuthorized", {
      message: `sender is not a member of direct Thread ${threadId} (DEC-03)`,
      retryable: false,
      fields: {},
    });
  }
  const recipientId: PersonId = senderId === a ? b : a;
  return { recipientId, pair: thread.direct.pair, existingThread: thread };
}

/**
 * DEC-14/A3 contact evaluation against the recipient's CURRENT ContactPolicy
 * (undefined = no record ≡ the DEC-14 default). Implied-allow sources: the
 * allowlist, defaultRule "allow", a shared Thread (the direct Thread for the
 * pair already exists — including, trivially, a thread:-addressed send), or
 * the self lane.
 */
async function contactPolicyAllows(
  deps: DecideSendDeps,
  senderId: PersonId,
  resolution: AddressResolution,
  contact: ContactPolicy | undefined,
): Promise<boolean | MessagingError> {
  const { recipientId } = resolution;
  if (recipientId === senderId) return true; // (me, me) personal lane (Plan §8)
  const allowlist = contact?.allowlist ?? DEFAULT_CONTACT_POLICY.allowlist;
  const defaultRule = contact?.defaultRule ?? DEFAULT_CONTACT_POLICY.defaultRule;
  if (allowlist.includes(senderId)) return true;
  if (defaultRule === "allow") return true;
  if (resolution.existingThread) return true; // thread:-addressed → the pair shares this Thread
  const shared = await deps.store.getDirectThread(senderId, recipientId);
  if (shared.kind === "error" && shared.error.name !== "RecordNotFound") {
    return storeDependencyError(shared.error);
  }
  return shared.kind === "ok";
}

export async function decideSend(
  deps: DecideSendDeps,
  principal: Principal,
  input: SendMessageInput,
  requestHash: RequestHash,
  clientMessageId: ClientMessageId,
): Promise<SendDecision> {
  const { store, clock } = deps;
  const senderId = principal.personId;

  const resolution = await resolveAddress(deps, senderId, input);
  if (resolution instanceof MessagingError) return { kind: "reject", error: resolution };

  // One read of the recipient's current policy pair feeds BOTH the contact
  // check and the DND/urgent decision — policy is evaluated against CURRENT
  // state at every decision point (R5), from a single resolution.
  const recipientPolicies = await store.getPolicy(resolution.recipientId);
  if (recipientPolicies.kind === "error" && recipientPolicies.error.name !== "RecordNotFound") {
    return { kind: "reject", error: storeDependencyError(recipientPolicies.error) };
  }
  const recipientContact = recipientPolicies.kind === "ok" ? recipientPolicies.value.contact : undefined;
  const recipientDndEnabled =
    recipientPolicies.kind === "ok" ? (recipientPolicies.value.dnd?.enabled ?? false) : false;

  const allowed = await contactPolicyAllows(deps, senderId, resolution, recipientContact);
  if (allowed instanceof MessagingError) return { kind: "reject", error: allowed };
  if (!allowed) {
    return {
      kind: "reject",
      error: new MessagingError("BlockedByContactPolicy", {
        message: `recipient ${resolution.recipientId} ContactPolicy blocks this sender (DEC-14, R4)`,
        retryable: false,
        fields: { recipientId: resolution.recipientId },
      }),
    };
  }

  // DND + urgent (W1): the flag is computed at acceptance against CURRENT
  // policy and persisted; the R5 machine re-evaluates DND at every attempt
  // decision point (acceptance, presence-open re-trigger, each retry).
  const hasOverrideGrant = principal.grants.includes("priority.override");
  const urgentDowngraded =
    input.priority === "urgent" && recipientDndEnabled && !hasOverrideGrant;

  const now = clock.now();
  const message: Message = {
    id: clock.newId("message"),
    kind: "message",
    schemaVersion,
    createdAt: now,
    threadId: SIZE_CHECK_THREAD_ID, // stamped by the store at commit (DEC-20)
    senderId,
    clientMessageId,
    sequence: 0 as Sequence, // assigned by the store inside the transaction (DEC-19)
    priority: input.priority, // the field never rewrites; the flag qualifies it (MSG-010)
    body: input.body,
  };

  // R13: serialized Message JSON bytes, enforced at validation.
  const sizeProbe: Message = { ...message, sequence: SIZE_CHECK_SEQUENCE };
  if (Buffer.byteLength(JSON.stringify(sizeProbe), "utf8") > constants.messageMaxBytes) {
    return {
      kind: "reject",
      error: new MessagingError("ValidationFailed", {
        message: `serialized Message exceeds constants.messageMaxBytes (${constants.messageMaxBytes})`,
        retryable: false,
        fields: {
          issues: [{ path: "body", message: `serialized Message exceeds ${constants.messageMaxBytes} bytes (R13)` }],
        },
      }),
    };
  }

  const snapshot: RecipientSnapshot = {
    id: clock.newId("snapshot"),
    kind: "recipient-snapshot",
    schemaVersion,
    createdAt: now,
    messageId: message.id,
    recipients: [resolution.recipientId],
  };

  const deliveries: Delivery[] = [
    {
      id: clock.newId("delivery"),
      kind: "delivery",
      schemaVersion,
      createdAt: now,
      updatedAt: now,
      messageId: message.id,
      threadId: SIZE_CHECK_THREAD_ID, // stamped by the store at commit
      recipientId: resolution.recipientId,
      state: "pending", // R5 initial state; all transitions run through the store CAS
    },
  ];

  const acceptance: AcceptanceInput = {
    idempotency: { senderId, clientMessageId, requestHash },
    thread: { kind: "direct", pair: resolution.pair },
    message,
    snapshot,
    deliveries,
    ...(urgentDowngraded ? { urgentDowngraded: true } : {}),
  };

  return { kind: "accept", input: acceptance, message, deliveries };
}

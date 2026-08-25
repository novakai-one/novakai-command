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
 *    (DEC-03); thread: → an existing Thread — DIRECT (sender ∈ canonical
 *    pair, recipient is the other member, R4) or ROOM (S2).
 *  - Room sends (S2, DEC-04/05, R4, R8): the room Thread must pre-exist
 *    (Store-Seam §2.1/§11.4). Membership resolves FRESH inside the accept
 *    call via the membership seam (Seams §3.2: no cached rosters); the
 *    revision evidence freezes into the RecipientSnapshot; the R4 sender
 *    check is `sender ∈ members` from the SAME resolution (§3.2.4 — never a
 *    second isMember call against a potentially different revision).
 *    UnknownRoom → UnknownThread; unavailable → DependencyUnavailable
 *    {membership, retryable: true} (never a stale/partial roster, I5).
 *  - Room fan-out (DEC-05, MSG-002): ONE Message + one Delivery per
 *    snapshotted member — the resolved member set IS the recipient set,
 *    sender included (a member sender receives their own Delivery, exactly
 *    like the (me, me) direct lane). Blocked recipients (ContactPolicy, R4):
 *    evaluated per recipient — allowlist, defaultRule "allow", a shared
 *    DIRECT Thread, or the self lane; room co-membership is NOT an
 *    implied-allow source (DEC-14's "shared Threads" can only mean direct
 *    Threads — otherwise R4's blocked path could never fire). A blocked
 *    recipient is recorded on the snapshot (blocked[]) and their Delivery
 *    commits TERMINAL failed{blocked-by-contact-policy} INSIDE
 *    commitAcceptance (Store-Seam §11.7 — R4's "terminal AT ACCEPTANCE"
 *    made literal: the zero-transition shape of R5's pending → failed
 *    {policy-blocked}, stamped by the store in the same transaction that
 *    stamps thread/sequence). The send itself is accepted and
 *    BlockedByContactPolicy is NEVER a room-send error (R4).
 *  - "Acceptance time" (I5, F4): the per-recipient contact/DND evaluation is
 *    THE decideSend evaluation — one read pair per recipient, taken
 *    CONCURRENTLY during this call (Promise.all collapses the old N×2
 *    sequential smear), then frozen ATOMICALLY at commit. I5's honesty is
 *    about the frozen RECORD being a true, never-rewriting account of what
 *    was evaluated — not about a cross-recipient instant, which no set of
 *    reads could ever have. The snapshot and its membership evidence are
 *    that record.
 *  - UnknownRecipient (MSG-014): the address must resolve to a provisioned
 *    Person (provisioning directory at the authority trust boundary).
 *  - ContactPolicy (DEC-14, A3, R4): per-recipient send right. A3's most
 *    literal reading: an absent ContactPolicy record ≡ the DEC-14 default
 *    {allowlist: [], defaultRule: "deny"} — deny-by-default is preserved and
 *    provisioning grants addressability, NOT send-right. Implied-allow: the
 *    allowlist, defaultRule "allow", or SHARING a direct Thread with the
 *    recipient. The self-send lane (me, me) is always allowed (Plan §8).
 *    Direct-send blocking rejects the whole send with BlockedByContactPolicy.
 *  - Urgent vs DND (DEC-07, MSG-010, W1): priority "urgent" against a
 *    DND-enabled recipient without the priority.override grant downgrades with
 *    a typed outcome — urgentDowngraded is computed HERE and persisted on the
 *    AcceptanceRecord (Store-Seam §11.3) so idempotent retries keep it. For
 *    rooms the flag generalizes: urgent && !grant && ANY deliverable
 *    (non-blocked) recipient has DND enabled at acceptance; the R5 machine
 *    then re-evaluates DND per recipient at every attempt decision point.
 *  - Message size (R13): serialized Message JSON must not exceed
 *    constants.messageMaxBytes → ValidationFailed.
 *
 * Template sends (S4, DEC-15): SendFromTemplate renders into a
 * SendMessageInput upstream (core/templates.ts — R12 allowlist enforcement)
 * and enters HERE through the same door with an optional TemplateRef, which
 * is stamped onto the Message verbatim (frozen history, I10). There is no
 * template-specific policy: a rendered send is decided EXACTLY as SendMessage.
 */

import { constants, schemaVersion } from "../contract/schemas.js";
import { MessagingError } from "../contract/schemas.js";
import type {
  ClientMessageId,
  ContactPolicy,
  Delivery,
  MembershipEvidence,
  Message,
  PersonId,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  TemplateRef,
  Thread,
  ThreadId,
} from "../contract/schemas.js";
import type { SendMessageInput } from "../contract/schemas.js";
import type { ClockIds } from "../contract/ports/clock.js";
import type { Principal, ProvisioningDirectory } from "../contract/ports/authority.js";
import type { MembershipSource } from "../contract/ports/membership.js";
import type { AcceptanceInput, MessagingStore } from "../contract/ports/store.js";
import { storeDependencyError } from "./storeErrors.js";

export interface DecideSendDeps {
  store: MessagingStore;
  clock: ClockIds;
  provisioning: ProvisioningDirectory;
  membership: MembershipSource;
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

interface DirectResolution {
  kind: "direct";
  recipientId: PersonId;
  /** The direct pair for the store's get-or-create (DEC-03 canonicalisation). */
  pair: [PersonId, PersonId];
  /** Present when addressed by thread: ID (thread already exists). */
  existingThread?: Thread;
}

interface RoomResolution {
  kind: "room";
  /** The pre-existing room Thread (Store-Seam §2.1/§11.4). */
  thread: Thread;
  /** The resolved member set — IS the frozen recipient set (DEC-05, MSG-002). */
  members: PersonId[];
  /** R8: revision evidence from the SAME resolution that checked the sender. */
  evidence: MembershipEvidence;
}

type AddressResolution = DirectResolution | RoomResolution;

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
    return { kind: "direct", recipientId, pair: [senderId, recipientId] };
  }
  // thread: address (R4): the Thread must exist; its kind picks the lane.
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
  if (thread.threadKind === "direct" && thread.direct) {
    const [a, b] = thread.direct.pair;
    if (senderId !== a && senderId !== b) {
      return new MessagingError("NotAuthorized", {
        message: `sender is not a member of direct Thread ${threadId} (DEC-03)`,
        retryable: false,
        fields: {},
      });
    }
    const recipientId: PersonId = senderId === a ? b : a;
    return { kind: "direct", recipientId, pair: thread.direct.pair, existingThread: thread };
  }
  // Room Thread (S2, R4/R8): resolve membership FRESH inside the accept call
  // (Seams §3.2 — no cached rosters). The sender check consumes the SAME
  // resolution that freezes the snapshot (§3.2.4); a second isMember call
  // here would resolve against a potentially different revision — exactly
  // what R8 forbids.
  if (!thread.room) {
    // Contract: room payload present iff threadKind team|mission. Absence is
    // store-level corruption — halt-class, never a silent allow (G6).
    return storeDependencyError({
      name: "StoreCorrupt",
      message: `room Thread ${threadId} is missing its room payload`,
    });
  }
  const resolved = await deps.membership.resolveMembers(thread.room);
  if (resolved.kind === "unknown") {
    // §3.3 public mapping: UnknownRoom → UnknownThread (send and read).
    return new MessagingError("UnknownThread", {
      message: `room unknown to the membership authority: ${thread.room.authority}/${thread.room.externalId}`,
      retryable: false,
      fields: { threadId },
    });
  }
  if (resolved.kind === "unavailable") return resolved.error;
  if (!resolved.members.includes(senderId)) {
    return new MessagingError("NotAuthorized", {
      message: `sender is not a member of room Thread ${threadId} (R4 — same-resolution check, R8)`,
      retryable: false,
      fields: {},
    });
  }
  return { kind: "room", thread, members: resolved.members, evidence: resolved.evidence };
}

/**
 * DEC-14/A3 contact evaluation for ONE recipient against their CURRENT
 * ContactPolicy (undefined = no record ≡ the DEC-14 default). Implied-allow
 * sources: the allowlist, defaultRule "allow", a shared DIRECT Thread, or the
 * self lane. Room co-membership is deliberately NOT one (see header — R4's
 * blocked path must be able to fire).
 */
async function contactAllowsRecipient(
  deps: DecideSendDeps,
  senderId: PersonId,
  recipientId: PersonId,
  contact: ContactPolicy | undefined,
): Promise<boolean | MessagingError> {
  if (recipientId === senderId) return true; // (me, me) personal lane (Plan §8)
  const allowlist = contact?.allowlist ?? DEFAULT_CONTACT_POLICY.allowlist;
  const defaultRule = contact?.defaultRule ?? DEFAULT_CONTACT_POLICY.defaultRule;
  if (allowlist.includes(senderId)) return true;
  if (defaultRule === "allow") return true;
  const shared = await deps.store.getDirectThread(senderId, recipientId);
  if (shared.kind === "error" && shared.error.name !== "RecordNotFound") {
    return storeDependencyError(shared.error);
  }
  return shared.kind === "ok";
}

/** One read of a recipient's policy pair (RecordNotFound ≡ absent policies). */
async function recipientPolicies(
  deps: DecideSendDeps,
  recipientId: PersonId,
): Promise<{ contact?: ContactPolicy; dndEnabled: boolean } | MessagingError> {
  const policies = await deps.store.getPolicy(recipientId);
  if (policies.kind === "error" && policies.error.name !== "RecordNotFound") {
    return storeDependencyError(policies.error);
  }
  if (policies.kind === "error") return { dndEnabled: false };
  return {
    ...(policies.value.contact !== undefined ? { contact: policies.value.contact } : {}),
    dndEnabled: policies.value.dnd?.enabled ?? false,
  };
}

export async function decideSend(
  deps: DecideSendDeps,
  principal: Principal,
  input: SendMessageInput,
  requestHash: RequestHash,
  clientMessageId: ClientMessageId,
  /** DEC-15: present when this send was rendered from a template (S4) — stamped onto the Message verbatim (I10). */
  templateRef?: TemplateRef,
): Promise<SendDecision> {
  const { clock } = deps;
  const senderId = principal.personId;

  const resolution = await resolveAddress(deps, senderId, input);
  if (resolution instanceof MessagingError) return { kind: "reject", error: resolution };

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
    ...(templateRef !== undefined ? { template: templateRef } : {}),
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

  const hasOverrideGrant = principal.grants.includes("priority.override");

  if (resolution.kind === "room") {
    return decideRoomSend(deps, principal, input, resolution, message, requestHash, clientMessageId, now, hasOverrideGrant);
  }

  // --- direct lane ------------------------------------------------------------
  // One read of the recipient's current policy pair feeds BOTH the contact
  // check and the DND/urgent decision — policy is evaluated against CURRENT
  // state at every decision point (R5), from a single resolution.
  const policies = await recipientPolicies(deps, resolution.recipientId);
  if (policies instanceof MessagingError) return { kind: "reject", error: policies };

  // thread:-addressed direct send → the pair already shares this Thread.
  const allowed =
    resolution.existingThread !== undefined
      ? true
      : await contactAllowsRecipient(deps, senderId, resolution.recipientId, policies.contact);
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
  const urgentDowngraded =
    input.priority === "urgent" && policies.dndEnabled && !hasOverrideGrant;

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

/**
 * The room lane (DEC-04/05, R4, R8, I5): ONE Message in the pre-existing room
 * Thread, the resolved member set frozen as the RecipientSnapshot (with the
 * membership revision evidence, R8), one initial Delivery per member, and the
 * blocked set recorded on the snapshot (R4). Blocked Deliveries commit
 * TERMINAL failed{blocked-by-contact-policy} INSIDE commitAcceptance
 * (Store-Seam §11.7 — the store stamps them in the acceptance transaction
 * from the snapshot's blocked set, each with a journaled DeliveryUpdated so
 * the failure stays observable per MSG-016); BlockedByContactPolicy never
 * rejects a room send.
 */
async function decideRoomSend(
  deps: DecideSendDeps,
  principal: Principal,
  input: SendMessageInput,
  resolution: RoomResolution,
  message: Message,
  requestHash: RequestHash,
  clientMessageId: ClientMessageId,
  now: ReturnType<ClockIds["now"]>,
  hasOverrideGrant: boolean,
): Promise<SendDecision> {
  const { clock } = deps;
  const senderId = principal.personId;

  // F5: the core owns the contract record (recipients uniqueItems) — dedupe
  // HERE, first occurrence wins, even if a membership adapter repeats a
  // member; the snapshot, the Deliveries, and the blocked set all derive
  // from this deduped list.
  const members = [...new Set(resolution.members)];

  // F4: the per-recipient policy/thread reads run CONCURRENTLY. N×2 awaited
  // sequential reads between membership resolution and commit smeared
  // "acceptance time" across the roster; collapsing them bounds the smear
  // by the slowest single recipient's read pair. Promise.all preserves
  // order, so recipients/blocked/deliveries stay deterministic (member
  // resolution order).
  const evaluations = await Promise.all(
    members.map(async (member) => {
      const policies = await recipientPolicies(deps, member);
      if (policies instanceof MessagingError) return policies;
      const allowed = await contactAllowsRecipient(deps, senderId, member, policies.contact);
      if (allowed instanceof MessagingError) return allowed;
      return { member, policies, allowed };
    }),
  );

  const recipients: PersonId[] = [];
  const blocked: { personId: PersonId; reason: "blocked-by-contact-policy" }[] = [];
  const deliveries: Delivery[] = [];
  let anyDeliverableDnd = false;

  for (const evaluation of evaluations) {
    if (evaluation instanceof MessagingError) return { kind: "reject", error: evaluation };
    const { member, policies, allowed } = evaluation;
    recipients.push(member);
    if (!allowed) {
      blocked.push({ personId: member, reason: "blocked-by-contact-policy" });
    } else if (policies.dndEnabled) {
      anyDeliverableDnd = true;
    }
    deliveries.push({
      id: clock.newId("delivery"),
      kind: "delivery",
      schemaVersion,
      createdAt: now,
      updatedAt: now,
      messageId: message.id,
      threadId: SIZE_CHECK_THREAD_ID, // stamped by the store at commit
      recipientId: member,
      state: "pending", // R5 initial; §11.7: blocked ones commit terminal failed INSIDE commitAcceptance
    });
  }

  // MSG-010 generalized: downgraded when urgent lacks the grant and ANY
  // deliverable recipient has DND on at acceptance (per-recipient DND is
  // re-evaluated by the R5 machine at every attempt decision point).
  const urgentDowngraded =
    input.priority === "urgent" && anyDeliverableDnd && !hasOverrideGrant;

  const snapshot: RecipientSnapshot = {
    id: clock.newId("snapshot"),
    kind: "recipient-snapshot",
    schemaVersion,
    createdAt: now,
    messageId: message.id,
    recipients,
    ...(blocked.length > 0 ? { blocked } : {}),
    membership: resolution.evidence, // R8: frozen WITH the recipient set (I5)
  };

  const acceptance: AcceptanceInput = {
    idempotency: { senderId, clientMessageId, requestHash },
    thread: { kind: "room", threadId: resolution.thread.id },
    message,
    snapshot,
    deliveries,
    ...(urgentDowngraded ? { urgentDowngraded: true } : {}),
  };

  return { kind: "accept", input: acceptance, message, deliveries };
}

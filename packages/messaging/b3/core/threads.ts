/**
 * Thread resolve/mint — the surface the pre-build hold-out exam found missing.
 *
 * §12.5 requires a `threadId` on both `sendAgentMessage` and
 * `openConversationView`, and publishes nothing that produces one. Messaging
 * has always minted Threads implicitly inside `commitAcceptance` (direct
 * get-or-create on the canonical pair) or explicitly via `createRoomThread`
 * for rooms — but neither is reachable from a B3 caller holding two AgentIds.
 *
 * This module is that reachable surface, and nothing more: it does not invent
 * a Thread model, it resolves onto the two the store already has.
 *
 *   direct → the canonical sorted pair, get-or-create (DEC-03)
 *   group  → a room Thread keyed by the sorted participant set (§11.4)
 *
 * DEC-B3V4-17 is why groups are explicit at all: parenthood does not create a
 * group chat. Somebody has to ASK for one, and this is where they ask.
 */

import { b3err, b3fail, b3ok, type B3Result } from "@novakai/foundation/contract";
import type { PersonId, Thread } from "../../public/contract/index.js";
import type { MessagingStore, StoreError } from "../../seams/store.js";
import type {
  ConversationParticipant, EnsureDirectThreadInput, EnsureGroupThreadInput,
} from "../contract/api.js";
import { agentPersonId, GROUP_THREAD_AUTHORITY, groupExternalId } from "./identity.js";

export const personIdOf = (participant: ConversationParticipant): PersonId =>
  participant.kind === "agent"
    ? agentPersonId(participant.agentId)
    : (participant.personId as PersonId);

/** Store failure → the B3 error vocabulary. One place, so no call site guesses. */
export function storeError(error: StoreError): ReturnType<typeof b3err> {
  if (error.name === "RecordNotFound") {
    return b3err("ValidationFailed", `${error.record} ${error.id} does not exist`,
      { issues: [{ path: error.record, message: "unknown record" }] }, false);
  }
  if (error.name === "RevisionConflict" || error.name === "StateConflict") {
    return b3err("EndpointClaimConflict", `messaging store conflict: ${error.name}`,
      { ...error }, true);
  }
  return b3err("StoreUnavailable", `messaging store: ${error.name}`,
    { owner: "messaging", cause: error.name }, error.name === "StoreUnavailable");
}

/**
 * Get-or-create the direct Thread for a pair.
 *
 * The store creates direct Threads inside `commitAcceptance` and exposes
 * `getDirectThread` for lookup — but there is no "create an empty direct
 * Thread" operation, and inventing one would add a second Thread-creation path
 * to a store that deliberately has exactly one. So a direct Thread is
 * represented here as a resolved identity: the canonical pair IS the Thread's
 * identity, and the store materialises it on first acceptance.
 */
export async function ensureDirectThread(
  store: MessagingStore, input: EnsureDirectThreadInput,
): Promise<B3Result<Thread>> {
  const [first, second] = input.between;
  const personA = personIdOf(first);
  const personB = personIdOf(second);
  if (personA === personB) {
    return b3fail(b3err("ValidationFailed",
      "a direct Thread needs two different participants",
      { issues: [{ path: "between", message: "both participants are the same" }] }, false));
  }
  const existing = await store.getDirectThread(personA, personB);
  if (existing.kind === "ok") return b3ok(existing.value);
  if (existing.error.name !== "RecordNotFound") return b3fail(storeError(existing.error));

  // Not yet materialised. `createDirectThread` is the store's one creation
  // path for this shape; it is a get-or-create, so two racing callers converge.
  const created = await store.createDirectThread([personA, personB]);
  if (created.kind === "error") return b3fail(storeError(created.error));
  return b3ok(created.value);
}

export async function ensureGroupThread(
  store: MessagingStore, input: EnsureGroupThreadInput,
): Promise<B3Result<Thread>> {
  const participants = input.participants.map(personIdOf);
  if (new Set(participants).size < 2) {
    return b3fail(b3err("ValidationFailed",
      "a group Thread needs at least two distinct participants",
      { issues: [{ path: "participants", message: "fewer than two distinct" }] }, false));
  }
  const created = await store.createRoomThread({
    threadKind: "team",
    authority: GROUP_THREAD_AUTHORITY,
    externalId: groupExternalId(participants),
  });
  if (created.kind === "error") return b3fail(storeError(created.error));
  return b3ok(created.value);
}

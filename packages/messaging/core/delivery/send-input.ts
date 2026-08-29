import type { AgentDeliveryMarker } from '../../contract/agent-delivery-marker.js';
import type { ConversationSendInput } from '../../contract/commands.js';
import type { AgentDirectoryEntry } from '../../contract/ports/agent-directory.js';
import type { EnsureAgentPairConversationInput } from '../../contract/ports/conversation-directory.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import { findAgentDeliveryMarkerInLine } from './delivery-marker-codec.js';
import type { DeliveryStore } from './delivery-store.js';

/** The slice of the Agent directory routing needs: resolve a recipient and check it is idle. */
export interface RoutingAgents {
  get(agentId: string): Promise<AgentDirectoryEntry | null>;
  deliveryReadiness(agentId: string): Promise<'idle' | 'busy' | 'unavailable'>;
}

/** The slice of the conversation directory routing needs: the pair view a delivery is sent against. */
export interface PairConversations {
  ensureForAgentPair(
    input: EnsureAgentPairConversationInput,
  ): Promise<{ readonly conversationId: string }>;
}

/** The collaborator slice send-input building needs from the router. */
export interface SendInputDependencies {
  readonly store: DeliveryStore;
  readonly agents: RoutingAgents;
  readonly conversations: PairConversations;
}

/**
 * Why a queued delivery was not routed this pass: `deferred` means try again
 * next pass (the recipient has no session or is busy); `undeliverable` means
 * it can never succeed and carries the reason it must be failed with.
 */
export type RoutingHold =
  | { readonly ok: false; readonly kind: 'deferred' }
  | { readonly ok: false; readonly kind: 'undeliverable'; readonly reason: string };

/** Send input for one routable delivery, or the hold that stops it. */
export type SendInputOutcome =
  | { readonly ok: true; readonly input: ConversationSendInput }
  | RoutingHold;

/** The delivery-derived idempotency key; a resubmission finds the same send journal. */
export const clientOpIdFor = (delivery: PendingDelivery): string => `delivery:${delivery.id}`;

const deferred = (): RoutingHold => ({ ok: false, kind: 'deferred' });
const undeliverable = (reason: string): RoutingHold => ({
  ok: false,
  kind: 'undeliverable',
  reason,
});

/**
 * Turns a queued delivery back into a conversation send input: prove the
 * source line still carries the delivery's marker, resolve both participants,
 * then mint the send against the pair's conversation view.
 */
export async function buildSendInput(
  dependencies: SendInputDependencies,
  delivery: PendingDelivery,
): Promise<SendInputOutcome> {
  const source = await readDeliverySource(dependencies.store, delivery);
  if (!source.ok) return source;
  const sender = await senderFor(dependencies.store, delivery, source.line);
  if (!sender.ok) return sender;
  const recipient = await recipientFor(dependencies.agents, delivery);
  if (!recipient.ok) return recipient;
  const input = await conversationSendInput(
    dependencies.conversations,
    sender.senderAgentId,
    recipient.recipient,
    source.marker,
    delivery,
  );
  return { ok: true, input };
}

type DeliverySourceOutcome =
  | { readonly ok: true; readonly line: TranscriptLine; readonly marker: AgentDeliveryMarker }
  | RoutingHold;

/**
 * Reads the delivery's source transcript line and proves its marker still
 * names the recipient. Either fact going missing means the delivery can never
 * be reconstructed, so it is undeliverable rather than deferred.
 */
async function readDeliverySource(
  store: DeliveryStore,
  delivery: PendingDelivery,
): Promise<DeliverySourceOutcome> {
  const line = await store.getTranscriptLine(delivery.transcriptLineId);
  if (line === null) {
    return undeliverable(`source TranscriptLine ${delivery.transcriptLineId} is missing`);
  }
  const marker = findAgentDeliveryMarkerInLine(line);
  if (marker?.recipientAgentId !== delivery.recipientAgentId) {
    return undeliverable(`source TranscriptLine ${line.id} has no matching delivery marker`);
  }
  return { ok: true, line, marker };
}

type SenderOutcome =
  | { readonly ok: true; readonly senderAgentId: string }
  | RoutingHold;

/**
 * Resolves the sender: the source line's session must be assigned to an
 * Agent, and that Agent must not be the recipient — a delivery is a
 * conversation between two different participants. An unassigned session
 * defers, because assignment may land before the next pass.
 */
async function senderFor(
  store: DeliveryStore,
  delivery: PendingDelivery,
  line: TranscriptLine,
): Promise<SenderOutcome> {
  const session = (await store.listProviderSessions())
    .find((candidate) => candidate.id === line.sessionId);
  if (session?.agentId === undefined) return deferred();
  if (session.agentId === delivery.recipientAgentId) {
    return undeliverable('Agent delivery requires two different participants');
  }
  return { ok: true, senderAgentId: session.agentId };
}

type RecipientOutcome =
  | { readonly ok: true; readonly recipient: AgentDirectoryEntry }
  | RoutingHold;

/** The recipient is routable only with a session and nothing in flight on it. */
async function recipientReady(
  agents: RoutingAgents,
  recipient: AgentDirectoryEntry,
): Promise<boolean> {
  return recipient.currentProviderSessionId !== null
    && await agents.deliveryReadiness(recipient.agentId) === 'idle';
}

/**
 * Resolves the recipient: a missing Agent can never receive, while one
 * without an idle session is left queued for a later pass so its provider
 * session is never interrupted mid-turn.
 */
async function recipientFor(
  agents: RoutingAgents,
  delivery: PendingDelivery,
): Promise<RecipientOutcome> {
  const recipient = await agents.get(delivery.recipientAgentId);
  if (recipient === null) {
    return undeliverable(`recipient Agent ${delivery.recipientAgentId} is missing`);
  }
  if (!await recipientReady(agents, recipient)) return deferred();
  return { ok: true, recipient };
}

/** The send request one routable delivery becomes, against the pair's shared view. */
async function conversationSendInput(
  conversations: PairConversations,
  senderAgentId: string,
  recipient: AgentDirectoryEntry,
  marker: AgentDeliveryMarker,
  delivery: PendingDelivery,
): Promise<ConversationSendInput> {
  const participants: readonly [string, string] = senderAgentId <= recipient.agentId
    ? [senderAgentId, recipient.agentId]
    : [recipient.agentId, senderAgentId];
  const view = await conversations.ensureForAgentPair({
    participantAgentIds: participants,
    clientOpId: `delivery-view:${participants.join(':')}`,
  });
  return {
    conversationId: view.conversationId,
    issuedBy: senderAgentId,
    targetAgentId: recipient.agentId,
    text: marker.text,
    clientOpId: clientOpIdFor(delivery),
  };
}

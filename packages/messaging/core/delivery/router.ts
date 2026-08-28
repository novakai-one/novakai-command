import { findAgentDeliveryMarker } from './delivery-marker-codec.js';
import type { ConversationSendInput } from '../../contract/commands.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import { sendConversationMessage } from '../send/send.js';

interface DeliveryRouterDependencies {
  readonly store: TranscriptStore;
  readonly agents: AgentDirectory;
  readonly conversations: ConversationDirectory;
  readonly providerSend: ProviderSend;
  readonly now: () => string;
  readonly claimTimeoutMs?: number;
}

/** Running tally of what one delivery pass did; returned as the run result. */
interface DeliveryProgress {
  claimed: number;
  deferredBusy: number;
  submitted: number;
  failed: number;
  observed: number;
}

const zeroProgress = (values: Partial<DeliveryProgress> = {}): DeliveryProgress => ({
  claimed: values.claimed ?? 0,
  deferredBusy: values.deferredBusy ?? 0,
  submitted: values.submitted ?? 0,
  failed: values.failed ?? 0,
  observed: values.observed ?? 0,
});

const addProgress = (result: DeliveryProgress, next: DeliveryProgress): void => {
  result.claimed += next.claimed;
  result.deferredBusy += next.deferredBusy;
  result.submitted += next.submitted;
  result.failed += next.failed;
  result.observed += next.observed;
};

/**
 * Runs one delivery pass: close claims that went stale, mark submitted
 * deliveries whose send is now confirmed in the transcript, then route every
 * queued delivery to its recipient. This is the entry point of delivery
 * routing. A queued delivery only moves once its recipient Agent is idle, so
 * a provider session is never interrupted mid-turn; anything not ready stays
 * queued for the next pass.
 */
export async function routePendingDeliveries(
  dependencies: DeliveryRouterDependencies,
): Promise<DeliveryRunResult> {
  const now = dependencies.now();
  const result = zeroProgress();
  result.submitted = await closeStaleClaims(dependencies, now);
  result.observed = await observeConfirmedDeliveries(dependencies.store, now);
  const queued = (await dependencies.store.listPendingDeliveries())
    .filter((delivery) => delivery.state === 'queued');
  for (const delivery of queued) {
    addProgress(result, await routeOneDelivery(dependencies, delivery));
  }
  return result;
}

/**
 * Frees deliveries whose claim has gone stale — a worker claimed them but
 * never reported back within the timeout — by moving them to
 * submitted-unconfirmed so the transcript can still prove what happened.
 */
async function closeStaleClaims(
  dependencies: DeliveryRouterDependencies,
  now: string,
): Promise<number> {
  const threshold = Date.parse(now) - (dependencies.claimTimeoutMs ?? 30_000);
  let submitted = 0;
  for (const delivery of await dependencies.store.listPendingDeliveries()) {
    if (delivery.state !== 'claimed' || Date.parse(delivery.updatedAt) > threshold) continue;
    const moved = await dependencies.store.transitionPendingDelivery({
      id: delivery.id,
      expectedState: 'claimed',
      state: 'submitted-unconfirmed',
      updatedAt: now,
    });
    if (moved.changed) submitted += 1;
  }
  return submitted;
}

/**
 * Advances submitted deliveries to transcript-observed once the send they
 * produced is confirmed in the transcript, closing the delivery loop.
 */
async function observeConfirmedDeliveries(
  store: TranscriptStore,
  now: string,
): Promise<number> {
  const journals = new Map((await store.listSendJournals()).map((item) => [item.clientOpId, item]));
  let observed = 0;
  for (const delivery of await store.listPendingDeliveries()) {
    if (delivery.state !== 'submitted-confirmed' && delivery.state !== 'submitted-unconfirmed') continue;
    if (journals.get(clientOpIdFor(delivery))?.state !== 'confirmed') continue;
    const moved = await store.transitionPendingDelivery({
      id: delivery.id,
      expectedState: delivery.state,
      state: 'transcript-observed',
      updatedAt: now,
    });
    if (moved.changed) observed += 1;
  }
  return observed;
}

/**
 * Routes one queued delivery: build its send input, claim it, then submit it
 * through the normal conversation send so the delivery gets the same
 * journaling and one-shot dispatch as any host send.
 */
async function routeOneDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
): Promise<DeliveryProgress> {
  const input = await buildSendInput(dependencies, delivery);
  if (input === 'deferred') return zeroProgress({ deferredBusy: 1 });
  if (input instanceof Error) {
    return failDelivery(dependencies, delivery, 'queued', input.message);
  }
  const claim = await dependencies.store.transitionPendingDelivery({
    id: delivery.id,
    expectedState: 'queued',
    state: 'claimed',
    updatedAt: dependencies.now(),
  });
  return claim.changed
    ? submitClaimedDelivery(dependencies, delivery, input)
    : zeroProgress();
}

/**
 * Turns a queued delivery back into a conversation send input by reading its
 * source transcript line and checking both participants. Returns 'deferred'
 * when the recipient has no session or is busy — the delivery stays queued —
 * and an Error when the delivery can never succeed, with the reason.
 */
async function buildSendInput(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
): Promise<ConversationSendInput | 'deferred' | Error> {
  const line = await dependencies.store.getTranscriptLine(delivery.transcriptLineId);
  if (line === null) return new Error(`source TranscriptLine ${delivery.transcriptLineId} is missing`);
  const marker = findAgentDeliveryMarker(`${line.text}\n${line.raw}`);
  if (marker?.recipientAgentId !== delivery.recipientAgentId) {
    return new Error(`source TranscriptLine ${line.id} has no matching delivery marker`);
  }
  const session = (await dependencies.store.listProviderSessions())
    .find((candidate) => candidate.id === line.sessionId);
  if (session?.agentId === undefined) return 'deferred';
  if (session.agentId === delivery.recipientAgentId) {
    return new Error('Agent delivery requires two different participants');
  }
  const recipient = await dependencies.agents.get(delivery.recipientAgentId);
  if (recipient === null) return new Error(`recipient Agent ${delivery.recipientAgentId} is missing`);
  if (recipient.currentProviderSessionId === null
    || await dependencies.agents.deliveryReadiness(recipient.agentId) !== 'idle') return 'deferred';
  const participants = [session.agentId, recipient.agentId].sort() as [string, string];
  const view = await dependencies.conversations.ensureForAgentPair({
    participantAgentIds: participants,
    clientOpId: `delivery-view:${participants.join(':')}`,
  });
  return {
    conversationId: view.conversationId,
    issuedBy: session.agentId,
    targetAgentId: recipient.agentId,
    text: marker.text,
    clientOpId: clientOpIdFor(delivery),
  };
}

/**
 * Submits a claimed delivery by sending its text as a conversation message,
 * then records on the delivery whether that send reached the provider. The
 * delivery's clientOpId is derived from its own id, so a resubmission finds
 * the existing send journal instead of sending twice.
 */
async function submitClaimedDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  input: ConversationSendInput,
): Promise<DeliveryProgress> {
  try {
    const accepted = await sendConversationMessage({
      store: dependencies.store,
      agentDirectory: dependencies.agents,
      providerSend: dependencies.providerSend,
      now: dependencies.now,
    }, input);
    const journals = await dependencies.store.listSendJournals();
    const state = submissionState(findAcceptedJournal(accepted.sendId, journals));
    const moved = await dependencies.store.transitionPendingDelivery({
      id: delivery.id,
      expectedState: 'claimed',
      state,
      updatedAt: dependencies.now(),
      ...(state === 'failed'
        ? { failure: 'provider dispatch failed before transcript evidence' } : {}),
    });
    return zeroProgress(state === 'failed'
      ? { claimed: 1, failed: moved.changed ? 1 : 0 }
      : { claimed: 1, submitted: moved.changed ? 1 : 0 });
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    const failed = await failDelivery(dependencies, delivery, 'claimed', failure);
    return zeroProgress({ claimed: 1, failed: failed.failed });
  }
}

/** Records a delivery as failed with the reason it can never proceed. */
async function failDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  expectedState: 'queued' | 'claimed',
  failure: string,
): Promise<DeliveryProgress> {
  const moved = await dependencies.store.transitionPendingDelivery({
    id: delivery.id,
    expectedState,
    state: 'failed',
    updatedAt: dependencies.now(),
    failure,
  });
  return zeroProgress({ failed: moved.changed ? 1 : 0 });
}

const clientOpIdFor = (delivery: PendingDelivery): string => `delivery:${delivery.id}`;

/**
 * Maps a send journal onto the delivery state it implies: a confirmed send
 * means submitted-confirmed, a failed send means failed, and anything in
 * between is submitted with the provider's own certainty about the dispatch.
 */
const submissionState = (journal: SendJournal): PendingDelivery['state'] => {
  if (journal.state === 'confirmed') return 'submitted-confirmed';
  if (journal.state === 'failed') return 'failed';
  return journal.attempts.at(-1)?.submission === 'confirmed'
    ? 'submitted-confirmed' : 'submitted-unconfirmed';
};

function findAcceptedJournal(sendId: string, journals: readonly SendJournal[]): SendJournal {
  const journal = journals.find((candidate) => candidate.id === sendId);
  if (journal === undefined) throw new Error(`accepted SendJournal ${sendId} is missing`);
  return journal;
}

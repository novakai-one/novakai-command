import { findAgentDeliveryMarker } from './agent-delivery-marker.js';
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

const clientOpIdFor = (delivery: PendingDelivery): string => `delivery:${delivery.id}`;

const submissionState = (journal: SendJournal): PendingDelivery['state'] => {
  if (journal.state === 'confirmed') return 'submitted-confirmed';
  if (journal.state === 'failed') return 'failed';
  return journal.attempts.at(-1)?.submission === 'confirmed'
    ? 'submitted-confirmed' : 'submitted-unconfirmed';
};

async function observeConfirmed(
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

async function inputFor(
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

interface DeliveryProgress {
  readonly claimed: number;
  readonly deferredBusy: number;
  readonly submitted: number;
  readonly failed: number;
}

interface DeliveryAccumulator {
  claimed: number;
  deferredBusy: number;
  submitted: number;
  failed: number;
  observed: number;
}

const progress = (
  values: Partial<DeliveryProgress> = {},
): DeliveryProgress => ({
  claimed: values.claimed ?? 0,
  deferredBusy: values.deferredBusy ?? 0,
  submitted: values.submitted ?? 0,
  failed: values.failed ?? 0,
});

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
  return progress({ failed: moved.changed ? 1 : 0 });
}

async function submitClaimed(
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
    const state = submissionState(acceptedJournal(accepted.sendId, journals));
    const moved = await dependencies.store.transitionPendingDelivery({
      id: delivery.id,
      expectedState: 'claimed',
      state,
      updatedAt: dependencies.now(),
      ...(state === 'failed'
        ? { failure: 'provider dispatch failed before transcript evidence' } : {}),
    });
    return progress(state === 'failed'
      ? { claimed: 1, failed: moved.changed ? 1 : 0 }
      : { claimed: 1, submitted: moved.changed ? 1 : 0 });
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause);
    const failed = await failDelivery(dependencies, delivery, 'claimed', failure);
    return progress({ claimed: 1, failed: failed.failed });
  }
}

async function routeOne(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
): Promise<DeliveryProgress> {
  const input = await inputFor(dependencies, delivery);
  if (input === 'deferred') return progress({ deferredBusy: 1 });
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
    ? submitClaimed(dependencies, delivery, input)
    : progress();
}

function applyProgress(result: DeliveryAccumulator, next: DeliveryProgress): void {
  result.claimed += next.claimed;
  result.deferredBusy += next.deferredBusy;
  result.submitted += next.submitted;
  result.failed += next.failed;
}

/** Claims transcript-addressed work only at a proven recipient idle boundary. */
export async function routePendingDeliveries(
  dependencies: DeliveryRouterDependencies,
): Promise<DeliveryRunResult> {
  const now = dependencies.now();
  const result: DeliveryAccumulator = {
    claimed: 0,
    deferredBusy: 0,
    submitted: await closeStaleClaims(dependencies, now),
    failed: 0,
    observed: await observeConfirmed(dependencies.store, now),
  };
  const queued = (await dependencies.store.listPendingDeliveries())
    .filter((delivery) => delivery.state === 'queued');
  for (const delivery of queued) {
    applyProgress(result, await routeOne(dependencies, delivery));
  }
  return result;
}

function acceptedJournal(sendId: string, journals: readonly SendJournal[]): SendJournal {
  const journal = journals.find((candidate) => candidate.id === sendId);
  if (journal === undefined) throw new Error(`accepted SendJournal ${sendId} is missing`);
  return journal;
}

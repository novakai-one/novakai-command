import type {
  ConversationSendAcceptance,
  ConversationSendInput,
} from '../../contract/commands.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { DeliveryFailure, PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { DeliveryRunResult } from '../../contract/runtime.js';
import type { Timestamp } from '../../contract/types.js';
import { sendConversationMessage } from '../send/send.js';
import { present } from '../send/sparse.js';
import type { DeliveryStore } from './delivery-store.js';
import {
  buildSendInput,
  clientOpIdFor,
  type PairConversations,
  type RoutingAgents,
  type RoutingHold,
} from './send-input.js';

interface DeliveryRouterDependencies {
  readonly store: DeliveryStore;
  readonly agents: RoutingAgents;
  readonly conversations: PairConversations;
  readonly providerSend: ProviderSend;
  readonly now: () => Timestamp;
}

const zeroRun: DeliveryRunResult = {
  claimed: 0,
  deferredBusy: 0,
  submitted: 0,
  failed: 0,
  observed: 0,
};

/** One step's contribution to the run tally, counted against a zeroed run. */
const tally = (progress: Partial<DeliveryRunResult>): DeliveryRunResult => ({
  ...zeroRun,
  ...progress,
});

/** Two tallies combined into a new one; neither operand is disturbed. */
const addProgress = (
  left: DeliveryRunResult, 
  right: DeliveryRunResult): DeliveryRunResult => ({
  claimed: left.claimed + right.claimed,
  deferredBusy: left.deferredBusy + right.deferredBusy,
  submitted: left.submitted + right.submitted,
  failed: left.failed + right.failed,
  observed: left.observed + right.observed,
});

/**
 * Moves one delivery to a new state when it is still in the expected one.
 * Compare-and-set: if another worker moved it first, nothing changes and the
 * caller counts nothing.
 */
async function moveDelivery(
  store: DeliveryStore,
  delivery: PendingDelivery,
  expectedState: PendingDelivery['state'],
  state: PendingDelivery['state'],
  timestamp: Timestamp,
  failure?: DeliveryFailure,
): Promise<boolean> {
  const moved = await store.transitionPendingDelivery({
    id: delivery.id,
    expectedState,
    state,
    updatedAt: timestamp,
    ...present('failure', failure),
  });
  return moved.changed;
}

/**
 * Runs one delivery pass: close claims that went stale, mark submitted
 * deliveries whose send is now confirmed in the transcript, then route every
 * queued delivery to its recipient. This is the entry point of delivery
 * routing. A queued delivery only moves once its recipient Agent is idle, so
 * a provider session is never interrupted mid-turn; anything not ready stays
 * queued for the next pass.
 *
 * Crash recovery: a delivery claimed by a worker that never reports back is
 * freed by closeStaleClaims on a later pass, a submitted delivery whose send
 * reached transcript evidence is settled by observeConfirmedDeliveries, and
 * a submitted delivery with no transcript evidence past the confirmation
 * deadline is failed loudly by failUnconfirmedDeliveries — a message either
 * lands or visibly fails, it never hangs silently.
 * Crash ownership: a throw while submitting a claimed delivery is caught and
 * recorded as that delivery's typed failure, while throws during listing,
 * observing, or transitioning propagate to the caller.
 */
export async function routePendingDeliveries(
  dependencies: DeliveryRouterDependencies,
): Promise<DeliveryRunResult> {
  const timestamp = dependencies.now();
  let progress = tally({
    submitted: await closeStaleClaims(dependencies, timestamp),
    observed: await observeConfirmedDeliveries(dependencies.store, timestamp),
    failed: await failUnconfirmedDeliveries(dependencies, timestamp),
  });
  const queued = (await dependencies.store.listPendingDeliveries())
    .filter((delivery) => delivery.state === 'queued');
  for (const delivery of queued) {
    progress = addProgress(progress, await routeOneDelivery(dependencies, delivery));
  }
  return progress;
}

/** A claim older than this was abandoned by its worker and must be re-examined. */
const CLAIM_TIMEOUT_MS = 30_000;

/**
 * Confirmation means the message landed in the transcript, which a healthy
 * path shows within seconds of dispatch; two minutes covers a cold CLI
 * start, and past that the honest state is failed — never a silent hang.
 */
const CONFIRMATION_TIMEOUT_MS = 120_000;

/** A delivery whose last state change is longer ago than timeoutMs is overdue. */
const overdue = (delivery: PendingDelivery, timestamp: Timestamp, timeoutMs: number): boolean =>
  Date.parse(delivery.updatedAt) <= Date.parse(timestamp) - timeoutMs;

/**
 * Frees deliveries whose claim has gone stale — a worker claimed them but
 * never reported back within the timeout — by moving them to
 * submitted-unconfirmed so the transcript can still prove what happened.
 */
async function closeStaleClaims(
  dependencies: DeliveryRouterDependencies,
  timestamp: Timestamp,
): Promise<number> {
  const stale = (delivery: PendingDelivery): boolean =>
    delivery.state === 'claimed' && overdue(delivery, timestamp, CLAIM_TIMEOUT_MS);
  let submitted = 0;
  for (const delivery of (await dependencies.store.listPendingDeliveries()).filter(stale)) {
    if (await moveDelivery(
      dependencies.store, delivery, 'claimed', 'submitted-unconfirmed', timestamp,
    )) {
      submitted += 1;
    }
  }
  return submitted;
}

/** Only a delivery waiting on transcript evidence can be observed. */
const awaitsObservation = (delivery: PendingDelivery): boolean =>
  delivery.state === 'submitted-confirmed' || delivery.state === 'submitted-unconfirmed';

/**
 * Advances submitted deliveries to transcript-observed once the send they
 * produced is confirmed in the transcript, closing the delivery loop.
 */
async function observeConfirmedDeliveries(
  store: DeliveryStore,
  timestamp: Timestamp,
): Promise<number> {
  const journals = new Map((await store.listSendJournals()).map((item) => [item.clientOpId, item]));
  let observed = 0;
  for (const delivery of await store.listPendingDeliveries()) {
    observed += await observeIfConfirmed(store, delivery, journals, timestamp);
  }
  return observed;
}

/** Advances one submitted delivery to transcript-observed when its send journal is confirmed. */
async function observeIfConfirmed(
  store: DeliveryStore,
  delivery: PendingDelivery,
  journals: ReadonlyMap<string, SendJournal>,
  timestamp: Timestamp,
): Promise<number> {
  if (!awaitsObservation(delivery)) return 0;
  if (journals.get(clientOpIdFor(delivery))?.state !== 'confirmed') return 0;
  if (!await moveDelivery(store, delivery, delivery.state, 'transcript-observed', timestamp)) {
    return 0;
  }
  return 1;
}

/**
 * Fails a delivery stuck in submitted-unconfirmed past the confirmation
 * deadline: its send never produced transcript evidence, so the honest state
 * is failed with the deadline as evidence. Runs after
 * observeConfirmedDeliveries so fresh evidence always wins over the deadline.
 */
async function failUnconfirmedDeliveries(
  dependencies: DeliveryRouterDependencies,
  timestamp: Timestamp,
): Promise<number> {
  const stranded = (delivery: PendingDelivery): boolean =>
    delivery.state === 'submitted-unconfirmed'
    && overdue(delivery, timestamp, CONFIRMATION_TIMEOUT_MS);
  let failed = 0;
  for (const delivery of (await dependencies.store.listPendingDeliveries()).filter(stranded)) {
    const moved = await moveDelivery(
      dependencies.store, delivery, 'submitted-unconfirmed', 'failed', timestamp,
      { kind: 'confirmation-timeout', detail: 'no transcript evidence within the confirmation deadline' },
    );
    if (moved) failed += 1;
  }
  return failed;
}

/**
 * Routes one queued delivery: build its send input, claim it, then submit it
 * through the normal conversation send so the delivery gets the same
 * journaling and one-shot dispatch as any host send.
 */
async function routeOneDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
): Promise<DeliveryRunResult> {
  const built = await buildSendInput(dependencies, delivery);
  if (!built.ok) return recordHold(dependencies, delivery, built);
  const claimed = await moveDelivery(
    dependencies.store, delivery, 'queued', 'claimed', dependencies.now(),
  );
  if (!claimed) return tally({});
  return submitClaimedDelivery(dependencies, delivery, built.input);
}

/**
 * A deferred delivery stays queued for the next pass; an undeliverable one is
 * failed now with the routing reason it can never proceed.
 */
async function recordHold(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  outcome: RoutingHold,
): Promise<DeliveryRunResult> {
  if (outcome.kind === 'deferred') return tally({ deferredBusy: 1 });
  return failDelivery(
    dependencies, delivery, 'queued', { kind: 'routing-failed', detail: outcome.reason },
  );
}

/** The failure reason a thrown cause leaves behind for the delivery's evidence trail. */
const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Submits a claimed delivery by sending its text as a conversation message,
 * then records on the delivery whether that send reached the provider. The
 * delivery's clientOpId is derived from its own id, so a resubmission finds
 * the existing send journal instead of sending twice. Any throw along the way
 * — send slice, journal read, or the settlement write itself — is caught and
 * recorded as the delivery's typed submission-error failure, so a claimed
 * delivery never hangs without evidence.
 */
async function submitClaimedDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  input: ConversationSendInput,
): Promise<DeliveryRunResult> {
  try {
    return await submitAndSettle(dependencies, delivery, input);
  } catch (cause) {
    return failClaimedDelivery(
      dependencies, delivery, { kind: 'submission-error', detail: failureMessage(cause) },
    );
  }
}

/**
 * Runs the conversation send for one claimed delivery. A typed rejection
 * fails the delivery with the rejection carried whole as evidence; an
 * acceptance is settled against the send journal's evidence.
 */
async function submitAndSettle(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  input: ConversationSendInput,
): Promise<DeliveryRunResult> {
  const result = await sendConversationMessage({
    store: dependencies.store,
    agentDirectory: dependencies.agents,
    providerSend: dependencies.providerSend,
    now: dependencies.now,
  }, input);
  if (!result.ok) {
    return failClaimedDelivery(
      dependencies, delivery, { kind: 'send-rejected', rejection: result.rejection },
    );
  }
  return recordSubmissionOutcome(dependencies, delivery, result.acceptance);
}

/** One claimed delivery that failed, tallied. */
async function failClaimedDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  failure: DeliveryFailure,
): Promise<DeliveryRunResult> {
  const failed = await failDelivery(dependencies, delivery, 'claimed', failure);
  return tally({ claimed: 1, failed: failed.failed });
}

/** Claimed, plus failed or submitted depending on the state the send's evidence implies. */
function settlementProgress(
  state: PendingDelivery['state'],
  changed: boolean,
): DeliveryRunResult {
  const count = changed ? 1 : 0;
  if (state === 'failed') return tally({ claimed: 1, failed: count });
  return tally({ claimed: 1, submitted: count });
}

/**
 * Maps an accepted send back onto the delivery state it implies and moves the
 * delivery there. A failed transition means another worker settled the
 * delivery first, so the send's outcome is only counted when this pass moved it.
 */
async function recordSubmissionOutcome(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  acceptance: ConversationSendAcceptance,
): Promise<DeliveryRunResult> {
  const state = submissionState(
    findAcceptedJournal(acceptance.sendId, await dependencies.store.listSendJournals()),
  );
  const failure: DeliveryFailure | undefined = state === 'failed'
    ? { kind: 'dispatch-failed', detail: 'provider dispatch failed before transcript evidence' }
    : undefined;
  const moved = await moveDelivery(
    dependencies.store, delivery, 'claimed', state, dependencies.now(), failure,
  );
  return settlementProgress(state, moved);
}

/** Records a delivery as failed with the typed evidence of why it can never proceed. */
async function failDelivery(
  dependencies: DeliveryRouterDependencies,
  delivery: PendingDelivery,
  expectedState: 'queued' | 'claimed',
  failure: DeliveryFailure,
): Promise<DeliveryRunResult> {
  const moved = await moveDelivery(
    dependencies.store, delivery, expectedState, 'failed', dependencies.now(), failure,
  );
  if (!moved) return tally({});
  return tally({ failed: 1 });
}

/**
 * Maps a send journal onto the delivery state it implies: a confirmed send
 * means submitted-confirmed, a failed send means failed, and anything in
 * between is submitted with the provider's own certainty about the dispatch.
 */
const submissionState = (journal: SendJournal): PendingDelivery['state'] => {
  if (journal.state === 'confirmed') return 'submitted-confirmed';
  if (journal.state === 'failed') return 'failed';
  if (journal.attempts.at(-1)?.submission === 'confirmed') return 'submitted-confirmed';
  return 'submitted-unconfirmed';
};

/**
 * The journal the send slice just accepted must be in the store's own list;
 * its absence means the store broke its contract. The throw does not halt the
 * pass: submitClaimedDelivery catches it and records it as the delivery's
 * failure evidence, so one store defect fails one delivery rather than the run.
 */
function findAcceptedJournal(sendId: string, journals: readonly SendJournal[]): SendJournal {
  const journal = journals.find((candidate) => candidate.id === sendId);
  if (journal === undefined) throw new Error(`accepted SendJournal ${sendId} is missing`);
  return journal;
}

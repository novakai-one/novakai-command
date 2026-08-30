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
import { thrownMessage } from '../thrown.js';
import type { DeliveryStore } from './delivery-store.js';
import { failDelivery, moveDelivery, type DeliveryMoveDependencies } from './move-delivery.js';
import { tally } from './run-tally.js';
import type { RoutingAgents } from './send-input.js';

/** The collaborator slice submitting one claimed delivery needs. */
export interface SubmitDependencies extends DeliveryMoveDependencies {
  readonly agents: RoutingAgents;
  readonly providerSend: ProviderSend;
}

/**
 * Submits a claimed delivery by sending its text as a conversation message,
 * then records on the delivery whether that send reached the provider. The
 * delivery's clientOpId is derived from its own id, so a resubmission finds
 * the existing send journal instead of sending twice. Any throw along the way
 * — send slice, journal read, or the settlement write itself — is caught and
 * recorded as the delivery's typed submission-error failure, so a claimed
 * delivery never hangs without evidence.
 */
export async function submitClaimedDelivery(
  dependencies: SubmitDependencies,
  delivery: PendingDelivery,
  input: ConversationSendInput,
): Promise<DeliveryRunResult> {
  try {
    return await submitAndSettle(dependencies, delivery, input);
  } catch (cause) {
    return failClaimedDelivery(
      dependencies, delivery, { kind: 'submission-error', detail: thrownMessage(cause) },
    );
  }
}

/**
 * Runs the conversation send for one claimed delivery. A typed rejection
 * fails the delivery with the rejection carried whole as evidence; an
 * acceptance is settled against the send journal's evidence.
 */
async function submitAndSettle(
  dependencies: SubmitDependencies,
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
  dependencies: DeliveryMoveDependencies,
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
  dependencies: SubmitDependencies,
  delivery: PendingDelivery,
  acceptance: ConversationSendAcceptance,
): Promise<DeliveryRunResult> {
  const state = submissionState(
    findAcceptedJournal(acceptance.sendId, await dependencies.store.listSendJournals()),
  );
  const failure = dispatchFailure(state);
  const moved = await moveDelivery(
    dependencies.store, delivery, 'claimed', state, dependencies.now(), failure,
  );
  return settlementProgress(state, moved);
}

/** Dispatch failure evidence when the send's journal says it failed; absent otherwise. */
const dispatchFailure = (state: PendingDelivery['state']): DeliveryFailure | undefined => {
  if (state !== 'failed') return undefined;
  return { kind: 'dispatch-failed', detail: 'provider dispatch failed before transcript evidence' };
};

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

// Activity-drift transitions caused by newly observed free evidence.
import {
  b3fail,
  b3ok,
  type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import {
  type ClosedDriftStatus,
  type DriftCheckOutcome,
  type DriftEvidenceCheckpoint,
  type DurableDriftState,
} from '../../contract/index.js';
import { expireQueuedNotification } from './drift-notifications.js';
import {
  movementEvidenceRef,
  persistDrift,
  type CurrentDrift,
  type DriftDependencies,
  type DriftEvidenceObservation,
} from './drift-support.js';

async function deferClaimedMovement(
  deps: DriftDependencies,
  current: CurrentDrift,
  previous: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = previous.outstandingStatus;
  if (outstanding.state !== 'delivery-claimed') {
    throw new TypeError('claimed movement reducer received a non-claimed status');
  }
  const state: DurableDriftState = {
    ...previous,
    lastEvidence: nextEvidence,
    outstandingStatus: {
      ...outstanding,
      pendingMovementEvidenceRef: movementEvidenceRef(observed, nextEvidence),
    },
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'healthy-free-evidence',
    providerTurnsStartedThisEvaluation: 0,
    evidenceRefs: observed.evidenceRefs,
  });
}

async function closeSubmittedMovement(
  deps: DriftDependencies,
  current: CurrentDrift,
  previous: Extract<
    DurableDriftState,
    { readonly phase: 'status-outstanding' | 'escalated-waiting-human' }
  >,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = previous.outstandingStatus;
  if (outstanding.state !== 'submitted-confirmed'
    && outstanding.state !== 'submitted-unconfirmed') {
    throw new TypeError('submitted movement reducer received a non-submitted status');
  }
  const closureEvidenceRef = movementEvidenceRef(observed, nextEvidence);
  const replied = observed.replyEvidenceRef !== undefined;
  const closed: ClosedDriftStatus = {
    episodeId: outstanding.episodeId,
    effectKey: outstanding.effectKey,
    notificationId: outstanding.notificationId,
    state: replied ? 'replied' : 'activity-observed-after-submission',
    closedAt: observedAt.toISOString() as IsoUtc,
    closureEvidenceRef,
  };
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: previous.episodeOrdinal,
    phase: 'observing',
    quietIntervals: 0,
    consecutiveUnansweredChecks: 0,
    lastEvidence: nextEvidence,
    lastClosedStatus: closed,
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return replied
    ? b3ok({
      kind: 'status-replied',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveDrift: 0,
      replyEvidenceRef: observed.replyEvidenceRef!,
    })
    : b3ok({
      kind: 'healthy-free-evidence',
      providerTurnsStartedThisEvaluation: 0,
      evidenceRefs: observed.evidenceRefs,
    });
}

async function cancelQueuedStatus(
  deps: DriftDependencies,
  current: CurrentDrift,
  previous: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = previous.outstandingStatus;
  if (outstanding.state !== 'queued') {
    throw new TypeError('queued cancellation received a non-queued status');
  }
  // The effect is cancelled durably before the deadline says it is closed.
  const expired = await expireQueuedNotification(deps, outstanding);
  if (!expired.ok) return b3fail(expired.error);
  const closureEvidenceRef = movementEvidenceRef(observed, nextEvidence);
  const closed: ClosedDriftStatus = {
    episodeId: outstanding.episodeId,
    effectKey: outstanding.effectKey,
    notificationId: outstanding.notificationId,
    state: 'cancelled-before-delivery',
    closedAt: observedAt.toISOString() as IsoUtc,
    closureEvidenceRef,
  };
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: previous.episodeOrdinal,
    phase: 'observing',
    quietIntervals: 0,
    consecutiveUnansweredChecks: 0,
    lastEvidence: nextEvidence,
    lastClosedStatus: closed,
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-cancelled-before-delivery',
    providerTurnsStartedThisEvaluation: 0,
    episodeId: outstanding.episodeId,
    movementEvidenceRef: closureEvidenceRef,
  });
}

/** Establish the first sample or close an open episode when evidence moves. */
export async function recordMovement(
  deps: DriftDependencies,
  current: CurrentDrift,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const previous = current.deadline.driftState!;
  if (previous.phase === 'status-outstanding'
    && previous.outstandingStatus.state === 'queued') {
    return cancelQueuedStatus(deps, current, previous, observed, nextEvidence, observedAt);
  }
  if (previous.phase === 'status-outstanding'
    && previous.outstandingStatus.state === 'delivery-claimed') {
    return deferClaimedMovement(deps, current, previous, observed, nextEvidence, observedAt);
  }
  if ((previous.phase === 'status-outstanding'
      && (previous.outstandingStatus.state === 'submitted-confirmed'
        || previous.outstandingStatus.state === 'submitted-unconfirmed'))
    || previous.phase === 'escalated-waiting-human') {
    return closeSubmittedMovement(deps, current, previous, observed, nextEvidence, observedAt);
  }
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: previous.episodeOrdinal,
    phase: 'observing',
    quietIntervals: 0,
    consecutiveUnansweredChecks: 0,
    lastEvidence: nextEvidence,
    ...(previous.phase === 'observing' && previous.lastClosedStatus !== undefined
      ? { lastClosedStatus: previous.lastClosedStatus }
      : {}),
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'healthy-free-evidence',
    providerTurnsStartedThisEvaluation: 0,
    evidenceRefs: observed.evidenceRefs,
  });
}

// Activity-drift transitions when the canonical free evidence is unchanged.
import {
  b3fail,
  b3ok,
  type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import {
  deriveDriftEpisodeId,
  type DriftCheckOutcome,
  type DriftEvidenceCheckpoint,
  type DurableDriftState,
} from '../../contract/index.js';
import {
  ensureHumanEscalation,
  ensureStatusNotification,
} from './drift-notifications.js';
import {
  persistDrift,
  watcherConflict,
  type CurrentDrift,
  type DriftDependencies,
  type DriftEvidenceObservation,
} from './drift-support.js';

async function queueStatusTurn(
  deps: DriftDependencies,
  current: CurrentDrift,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
  episodeId: NonNullable<DurableDriftState['episodeId']>,
): Promise<B3Result<DriftCheckOutcome>> {
  const queued = await ensureStatusNotification(
    deps, current, observed, episodeId, observedAt.toISOString() as IsoUtc,
  );
  if (!queued.ok) return b3fail(queued.error);
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: current.deadline.driftState!.episodeOrdinal,
    phase: 'status-outstanding',
    quietIntervals: 2,
    episodeId,
    consecutiveUnansweredChecks: 0,
    lastEvidence: nextEvidence,
    outstandingStatus: {
      episodeId,
      effectKey: queued.value.deliveryEffectKey,
      notificationId: queued.value.id,
      state: 'queued',
      requestedAt: queued.value.createdAt,
    },
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-turn-queued',
    providerTurnsStartedThisEvaluation: 0,
    staleIntervals: 2,
    notificationId: queued.value.id,
    effectKey: queued.value.deliveryEffectKey,
  });
}

async function queueHumanEscalation(
  deps: DriftDependencies,
  current: CurrentDrift,
  priorState: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = priorState.outstandingStatus;
  if (outstanding.state !== 'submitted-confirmed'
    && outstanding.state !== 'submitted-unconfirmed') {
    return b3fail(watcherConflict('only a submitted status turn can escalate', {
      watchDeadlineId: current.deadline.id,
      deliveryState: outstanding.state,
    }));
  }
  const escalation = await ensureHumanEscalation(
    deps,
    current,
    priorState.episodeId,
    nextEvidence.evidenceRefs,
    observedAt.toISOString() as IsoUtc,
  );
  if (!escalation.ok) return b3fail(escalation.error);
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal: priorState.episodeOrdinal,
    phase: 'escalated-waiting-human',
    quietIntervals: 2,
    episodeId: priorState.episodeId,
    consecutiveUnansweredChecks: 3,
    outstandingStatus: outstanding,
    escalationNotificationId: escalation.value.id,
    lastEvidence: nextEvidence,
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'human-escalation-queued',
    providerTurnsStartedThisEvaluation: 0,
    consecutiveUnansweredChecks: 3,
    notificationId: escalation.value.id,
    state: 'escalated-waiting-human',
  });
}

async function keepQueuedStatus(
  deps: DriftDependencies,
  current: CurrentDrift,
  priorState: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = priorState.outstandingStatus;
  if (outstanding.state === 'submitted-confirmed'
    || outstanding.state === 'submitted-unconfirmed') {
    const nextCount = priorState.consecutiveUnansweredChecks + 1;
    if (nextCount > 2) {
      return queueHumanEscalation(deps, current, priorState, nextEvidence, observedAt);
    }
    if (current.rule.driftPolicy === undefined) {
      return b3fail(watcherConflict('activity-drift rule has no durable drift policy', {
        watchRuleId: current.rule.id,
      }));
    }
    const replyDueAt = new Date(
      Date.parse(outstanding.replyDueAt) + current.rule.driftPolicy.replyWindowMs,
    ).toISOString() as IsoUtc;
    const state: DurableDriftState = {
      ...priorState,
      lastEvidence: nextEvidence,
      consecutiveUnansweredChecks: nextCount as 1 | 2,
      outstandingStatus: { ...outstanding, replyDueAt },
    };
    const written = await persistDrift(deps, current, state, observedAt, replyDueAt);
    if (!written.ok) return b3fail(written.error);
    return b3ok({
      kind: 'status-still-unanswered',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveUnansweredChecks: nextCount as 1 | 2,
      effectKey: outstanding.effectKey,
    });
  }
  const state: DurableDriftState = { ...priorState, lastEvidence: nextEvidence };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-turn-queued',
    providerTurnsStartedThisEvaluation: 0,
    staleIntervals: 2,
    notificationId: outstanding.notificationId,
    effectKey: outstanding.effectKey,
  });
}

async function keepEscalated(
  deps: DriftDependencies,
  current: CurrentDrift,
  priorState: Extract<DurableDriftState, { readonly phase: 'escalated-waiting-human' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const state: DurableDriftState = { ...priorState, lastEvidence: nextEvidence };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'human-escalation-queued',
    providerTurnsStartedThisEvaluation: 0,
    consecutiveUnansweredChecks: 3,
    notificationId: priorState.escalationNotificationId,
    state: 'escalated-waiting-human',
  });
}

async function startQuietEpisode(
  deps: DriftDependencies,
  current: CurrentDrift,
  priorState: Extract<DurableDriftState, { readonly phase: 'observing' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const episodeOrdinal = priorState.episodeOrdinal + 1;
  const episodeId = deriveDriftEpisodeId({
    watchRuleId: current.rule.id,
    subjectKey: current.deadline.subjectKey,
    activityGeneration: current.deadline.activityGeneration,
    fingerprint: nextEvidence.fingerprint,
    episodeOrdinal,
  });
  const state: DurableDriftState = {
    kind: 'activity-drift',
    episodeOrdinal,
    phase: 'observing',
    quietIntervals: 1,
    episodeId,
    consecutiveUnansweredChecks: 0,
    lastEvidence: nextEvidence,
    ...(priorState.lastClosedStatus === undefined
      ? {}
      : { lastClosedStatus: priorState.lastClosedStatus }),
  };
  const written = await persistDrift(deps, current, state, observedAt);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'first-quiet-interval',
    providerTurnsStartedThisEvaluation: 0,
    staleIntervals: 1,
  });
}

/** Advance one due drift deadline after observing unchanged free evidence. */
export function advanceUnchangedEvidence(
  deps: DriftDependencies,
  current: CurrentDrift,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  observedAt: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const priorState = current.deadline.driftState!;
  if (priorState.phase === 'observing' && priorState.quietIntervals === 0) {
    return startQuietEpisode(deps, current, priorState, nextEvidence, observedAt);
  }
  if (priorState.phase === 'observing' && priorState.quietIntervals === 1) {
    return queueStatusTurn(
      deps, current, observed, nextEvidence, observedAt, priorState.episodeId,
    );
  }
  if (priorState.phase === 'status-outstanding') {
    return keepQueuedStatus(deps, current, priorState, nextEvidence, observedAt);
  }
  if (priorState.phase === 'escalated-waiting-human') {
    return keepEscalated(deps, current, priorState, nextEvidence, observedAt);
  }
  const unreachable: never = priorState;
  return unreachable;
}

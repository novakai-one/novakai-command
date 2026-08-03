// LANE B — the exact §9.2 activity-drift reducer.
//
// Free evidence is read through one host port. The reducer owns fingerprinting
// so adapters cannot accidentally count record ids, timestamps, or audit refs
// as movement. It owns no provider/Terminal command and therefore cannot start
// a turn while deciding whether evidence moved.
import {
  b3fail,
  b3ok,
  type B3Result,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveDriftEpisodeId,
  type CheckRunDriftInput,
  type ClosedDriftStatus,
  type DriftCheckOutcome,
  type DriftEvidenceCheckpoint,
  type DurableDriftState,
  type WatchDeadline,
  type WatchRule,
} from '../../contract/index.js';
import {
  ensureHumanEscalation,
  ensureStatusNotification,
  expireQueuedNotification,
} from './drift-notifications.js';
import {
  evidenceCheckpoint,
  loadCurrentDrift,
  movementEvidenceRef,
  persistDrift,
  watcherConflict,
  type CurrentDrift,
  type DriftDependencies,
  type DriftEvidenceObservation,
} from './drift-support.js';

export {
  driftEvidenceFingerprint,
  type DriftEvidenceObservation,
  type DriftEvidencePort,
} from './drift-support.js';

type DriftContext = SystemCommandContext<'sys_supervision'>;

/** Establish the first sample or clear an observing episode when evidence moves. */
async function recordMovement(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const previous = current.deadline.driftState!;
  if (previous.phase === 'status-outstanding'
    && previous.outstandingStatus.state === 'queued') {
    return cancelQueuedStatus(deps, current, previous, observed, nextEvidence, now);
  }
  if (previous.phase === 'status-outstanding'
    && previous.outstandingStatus.state === 'delivery-claimed') {
    return deferClaimedMovement(deps, current, previous, observed, nextEvidence, now);
  }
  if ((previous.phase === 'status-outstanding'
      && (previous.outstandingStatus.state === 'submitted-confirmed'
        || previous.outstandingStatus.state === 'submitted-unconfirmed'))
    || previous.phase === 'escalated-waiting-human') {
    return closeSubmittedMovement(deps, current, previous, observed, nextEvidence, now);
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
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'healthy-free-evidence',
    providerTurnsStartedThisEvaluation: 0,
    evidenceRefs: observed.evidenceRefs,
  });
}

async function deferClaimedMovement(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  previous: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
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
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'healthy-free-evidence',
    providerTurnsStartedThisEvaluation: 0,
    evidenceRefs: observed.evidenceRefs,
  });
}

async function closeSubmittedMovement(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  previous: Extract<
    DurableDriftState,
    { readonly phase: 'status-outstanding' | 'escalated-waiting-human' }
  >,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
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
    closedAt: now.toISOString() as IsoUtc,
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
  const written = await persistDrift(deps, current, state, now);
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
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  previous: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
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
    closedAt: now.toISOString() as IsoUtc,
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
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-cancelled-before-delivery',
    providerTurnsStartedThisEvaluation: 0,
    episodeId: outstanding.episodeId,
    movementEvidenceRef: closureEvidenceRef,
  });
}

async function queueStatusTurn(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
  episodeId: NonNullable<DurableDriftState['episodeId']>,
): Promise<B3Result<DriftCheckOutcome>> {
  const queued = await ensureStatusNotification(
    deps, current, observed, episodeId, now.toISOString() as IsoUtc,
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
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-turn-queued',
    providerTurnsStartedThisEvaluation: 0,
    staleIntervals: 2,
    notificationId: queued.value.id,
    effectKey: queued.value.deliveryEffectKey,
  });
}

async function keepQueuedStatus(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  priorState: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const outstanding = priorState.outstandingStatus;
  if (outstanding.state === 'submitted-confirmed'
    || outstanding.state === 'submitted-unconfirmed') {
    const nextCount = priorState.consecutiveUnansweredChecks + 1;
    if (nextCount > 2) {
      return queueHumanEscalation(deps, current, priorState, nextEvidence, now);
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
    const written = await persistDrift(deps, current, state, now, replyDueAt);
    if (!written.ok) return b3fail(written.error);
    return b3ok({
      kind: 'status-still-unanswered',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveUnansweredChecks: nextCount as 1 | 2,
      effectKey: outstanding.effectKey,
    });
  }
  const state: DurableDriftState = { ...priorState, lastEvidence: nextEvidence };
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'status-turn-queued',
    providerTurnsStartedThisEvaluation: 0,
    staleIntervals: 2,
    notificationId: outstanding.notificationId,
    effectKey: outstanding.effectKey,
  });
}

async function queueHumanEscalation(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  priorState: Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
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
    now.toISOString() as IsoUtc,
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
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'human-escalation-queued',
    providerTurnsStartedThisEvaluation: 0,
    consecutiveUnansweredChecks: 3,
    notificationId: escalation.value.id,
    state: 'escalated-waiting-human',
  });
}

async function keepEscalated(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  priorState: Extract<DurableDriftState, { readonly phase: 'escalated-waiting-human' }>,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const state: DurableDriftState = { ...priorState, lastEvidence: nextEvidence };
  const written = await persistDrift(deps, current, state, now);
  if (!written.ok) return b3fail(written.error);
  return b3ok({
    kind: 'human-escalation-queued',
    providerTurnsStartedThisEvaluation: 0,
    consecutiveUnansweredChecks: 3,
    notificationId: priorState.escalationNotificationId,
    state: 'escalated-waiting-human',
  });
}

/** §9.2 steps 1–3: fingerprint, movement reset, and first quiet interval. */
export async function checkRunDrift(
  deps: DriftDependencies,
  _context: DriftContext,
  input: CheckRunDriftInput,
): Promise<B3Result<DriftCheckOutcome>> {
  const current = await loadCurrentDrift(deps, input);
  if (!current.ok) return b3fail(current.error);
  const now = deps.clock();
  if (now.getTime() < Date.parse(current.value.deadline.dueAt)) {
    return b3fail(watcherConflict('the drift deadline is not due', {
      watchDeadlineId: current.value.deadline.id,
      dueAt: current.value.deadline.dueAt,
      checkedAt: now.toISOString(),
    }));
  }
  const observed = await deps.evidence.observe(input.agentRunId);
  if (!observed.ok) return b3fail(observed.error);
  if (observed.value.terminalActivityGeneration !== input.expectedActivityGeneration) {
    return b3fail(watcherConflict('free evidence belongs to another activity generation', {
      expectedActivityGeneration: input.expectedActivityGeneration,
      observedActivityGeneration: observed.value.terminalActivityGeneration,
    }));
  }
  const nextEvidence = evidenceCheckpoint(observed.value, now.toISOString() as IsoUtc);
  const priorState = current.value.deadline.driftState!;
  const moved = priorState.lastEvidence === undefined
    || priorState.lastEvidence.fingerprint !== nextEvidence.fingerprint;
  if (moved) {
    return recordMovement(deps, current.value, observed.value, nextEvidence, now);
  }
  if (priorState.phase === 'observing' && priorState.quietIntervals === 0) {
    const episodeOrdinal = priorState.episodeOrdinal + 1;
    const episodeId = deriveDriftEpisodeId({
      watchRuleId: current.value.rule.id,
      subjectKey: current.value.deadline.subjectKey,
      activityGeneration: current.value.deadline.activityGeneration,
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
    const written = await persistDrift(deps, current.value, state, now);
    if (!written.ok) return b3fail(written.error);
    return b3ok({
      kind: 'first-quiet-interval',
      providerTurnsStartedThisEvaluation: 0,
      staleIntervals: 1,
    });
  }
  if (priorState.phase === 'observing' && priorState.quietIntervals === 1) {
    return queueStatusTurn(
      deps,
      current.value,
      observed.value,
      nextEvidence,
      now,
      priorState.episodeId,
    );
  }
  if (priorState.phase === 'status-outstanding') {
    return keepQueuedStatus(deps, current.value, priorState, nextEvidence, now);
  }
  if (priorState.phase === 'escalated-waiting-human') {
    return keepEscalated(deps, current.value, priorState, nextEvidence, now);
  }
  const unreachable: never = priorState;
  return unreachable;
}

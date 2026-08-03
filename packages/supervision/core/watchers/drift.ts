// LANE B — the exact §9.2 activity-drift reducer.
//
// Free evidence is read through one host port. The reducer owns fingerprinting
// so adapters cannot accidentally count record ids, timestamps, or audit refs
// as movement. It owns no provider/Terminal command and therefore cannot start
// a turn while deciding whether evidence moved.
import { createHash } from 'node:crypto';
import {
  b3err,
  b3fail,
  b3ok,
  deriveClientOpId,
  type ActivityGeneration,
  type AgentId,
  type AgentRunId,
  type B3Result,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveDriftEpisodeId,
  deriveNotificationId,
  DRIFT_STATUS_PROMPT,
  notificationDeliveryEffectKey,
  SUPERVISION_RECORD_WRITER,
  type CheckRunDriftInput,
  type DriftCheckOutcome,
  type DriftEvidenceCheckpoint,
  type DurableDriftState,
  type Notification,
  type WatchDeadline,
  type WatchRule,
} from '../../contract/index.js';
import type { Persisted, SupervisionStore } from '../store.js';

/** Activity-bearing facts read from their owning capabilities at check time. */
export interface DriftEvidenceObservation {
  /** Stable Agent identity resolved with the Run; status requests target this. */
  readonly agentId: AgentId;
  readonly terminalLiveness: 'live' | 'exited' | 'unknown';
  readonly terminalActivityGeneration: ActivityGeneration;
  readonly transcriptWatermark?: string;
  readonly usageActivityDigest?: string;
  readonly usageSourceCursor?: string;
  readonly evidenceRefs: readonly string[];
  /** Positive evidence that a causally later provider reply was committed. */
  readonly replyEvidenceRef?: string;
}

/** Host seam joining Terminal, Transcript, and usage truth without private imports. */
export interface DriftEvidencePort {
  observe(agentRunId: AgentRunId): Promise<B3Result<DriftEvidenceObservation>>;
}

export interface DriftDependencies {
  readonly store: SupervisionStore;
  readonly evidence: DriftEvidencePort;
  readonly clock: () => Date;
}

type DriftContext = SystemCommandContext<'sys_supervision'>;

const watcherConflict = (
  message: string,
  details: Readonly<Record<string, unknown>>,
) => b3err('WatcherConflict', message, details, true);

/** Stable scalar over only the activity-bearing fields named by §9.2 step 1. */
export function driftEvidenceFingerprint(
  evidence: Omit<DriftEvidenceObservation, 'agentId' | 'evidenceRefs' | 'replyEvidenceRef'>,
): string {
  const scalar = [
    'b3v4',
    'activity-drift-evidence',
    evidence.terminalLiveness,
    String(evidence.terminalActivityGeneration),
    evidence.transcriptWatermark ?? '-',
    evidence.usageActivityDigest ?? '-',
    evidence.usageSourceCursor ?? '-',
  ].join('\u001f');
  return createHash('sha256').update(scalar, 'utf8').digest('hex');
}

function statusNotificationRecord(
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observed: DriftEvidenceObservation,
  episodeId: NonNullable<DurableDriftState['episodeId']>,
  createdAt: IsoUtc,
): Persisted<Notification> & Record<string, unknown> {
  const notificationId = deriveNotificationId({
    watchRuleId: current.rule.id,
    subjectKey: current.deadline.subjectKey,
    condition: current.rule.condition,
    activityGeneration: current.deadline.activityGeneration,
    episodeId,
    phase: 'drift-status-request',
  });
  const effectKey = notificationDeliveryEffectKey(notificationId, episodeId);
  return {
    kind: 'notification',
    id: notificationId,
    schemaVersion: 1,
    createdAt,
    permissionLevel: 'private',
    createdBy: SUPERVISION_RECORD_WRITER,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: current.rule.id,
    subject: current.rule.subject,
    recipient: { kind: 'agent', agentId: observed.agentId },
    conditionGeneration: Number(current.deadline.activityGeneration),
    summary: DRIFT_STATUS_PROMPT,
    evidenceRefs: observed.evidenceRefs,
    state: 'queued',
    deliveryMode: 'start-turn',
    phase: 'drift-status-request',
    driftEpisodeId: episodeId,
  };
}

/** Queue-before-deadline transition; deterministic identity absorbs crash replay. */
async function ensureStatusNotification(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observed: DriftEvidenceObservation,
  episodeId: NonNullable<DurableDriftState['episodeId']>,
  createdAt: IsoUtc,
): Promise<B3Result<Notification>> {
  const record = statusNotificationRecord(current, observed, episodeId, createdAt);
  const existing = await deps.store.read<Notification>('notification', record.id);
  if (!existing.ok) return b3fail(existing.error);
  if (existing.value !== null) {
    const matches = existing.value.phase === 'drift-status-request'
      && existing.value.driftEpisodeId === episodeId
      && existing.value.deliveryEffectKey === record.deliveryEffectKey;
    return matches
      ? b3ok(existing.value)
      : b3fail(watcherConflict('the drift status notification identity is occupied', {
        notificationId: record.id,
        episodeId,
      }));
  }
  return deps.store.create<Notification>(
    SUPERVISION_RECORD_WRITER,
    record,
    deriveClientOpId(`b3v4:queue-drift-status:${record.id}`),
  );
}

function checkpoint(
  observation: DriftEvidenceObservation,
  checkedAt: IsoUtc,
): DriftEvidenceCheckpoint {
  return {
    fingerprint: driftEvidenceFingerprint(observation),
    terminalLiveness: observation.terminalLiveness,
    terminalActivityGeneration: observation.terminalActivityGeneration,
    ...(observation.transcriptWatermark === undefined
      ? {}
      : { transcriptWatermark: observation.transcriptWatermark }),
    ...(observation.usageActivityDigest === undefined
      ? {}
      : { usageActivityDigest: observation.usageActivityDigest }),
    ...(observation.usageSourceCursor === undefined
      ? {}
      : { usageSourceCursor: observation.usageSourceCursor }),
    evidenceRefs: observation.evidenceRefs,
    checkedAt,
  };
}

async function loadCurrent(
  deps: DriftDependencies,
  input: CheckRunDriftInput,
): Promise<B3Result<{ readonly rule: WatchRule; readonly deadline: WatchDeadline }>> {
  const [rule, deadline] = await Promise.all([
    deps.store.read<WatchRule>('watchRule', input.watchRuleId),
    deps.store.read<WatchDeadline>('watchDeadline', input.dueDeadlineId),
  ]);
  if (!rule.ok) return b3fail(rule.error);
  if (!deadline.ok) return b3fail(deadline.error);
  if (rule.value === null || deadline.value === null) {
    return b3fail(watcherConflict('the drift rule or deadline no longer exists', {
      watchRuleId: input.watchRuleId,
      watchDeadlineId: input.dueDeadlineId,
    }));
  }
  const current = deadline.value;
  const subjectMatches = rule.value.subject.kind === 'agent-run'
    && rule.value.subject.agentRunId === input.agentRunId;
  const matches = current.watchRuleId === input.watchRuleId
    && subjectMatches
    && current.activityGeneration === input.expectedActivityGeneration
    && Number(current.recordVersion) === Number(input.expectedDeadlineRecordVersion)
    && rule.value.condition.kind === 'activity-drift'
    && current.driftState !== undefined
    && current.state !== 'fired'
    && current.state !== 'superseded';
  if (!matches) {
    return b3fail(watcherConflict('the drift check fence does not match current durable truth', {
      watchRuleId: input.watchRuleId,
      watchDeadlineId: input.dueDeadlineId,
      expectedActivityGeneration: input.expectedActivityGeneration,
      actualActivityGeneration: current.activityGeneration,
      expectedRecordVersion: input.expectedDeadlineRecordVersion,
      actualRecordVersion: current.recordVersion,
    }));
  }
  return b3ok({ rule: rule.value, deadline: current });
}

function rearmedDueAt(now: Date, rule: WatchRule): IsoUtc {
  if (rule.condition.kind !== 'activity-drift') {
    throw new TypeError('activity-drift reducer received a non-drift rule');
  }
  return new Date(now.getTime() + rule.condition.intervalMs).toISOString() as IsoUtc;
}

async function persistDrift(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  state: DurableDriftState,
  now: Date,
): Promise<B3Result<WatchDeadline>> {
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    current.deadline.id,
    {
      state: 'armed',
      dueAt: rearmedDueAt(now, current.rule),
      driftState: state,
    },
    current.deadline.recordVersion,
    deriveClientOpId(
      `b3v4:check-run-drift:${current.deadline.id}:${String(current.deadline.recordVersion)}`,
    ),
  );
}

/** Establish the first sample or clear an observing episode when evidence moves. */
async function recordMovement(
  deps: DriftDependencies,
  current: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
  now: Date,
): Promise<B3Result<DriftCheckOutcome>> {
  const previous = current.deadline.driftState!;
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
  if (outstanding.state !== 'queued' && outstanding.state !== 'delivery-claimed') {
    return b3fail(b3err(
      'UnsupportedOperation',
      'submitted reply windows are not implemented by the current vertical slice',
      { state: outstanding.state },
      false,
    ));
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

/** §9.2 steps 1–3: fingerprint, movement reset, and first quiet interval. */
export async function checkRunDrift(
  deps: DriftDependencies,
  _context: DriftContext,
  input: CheckRunDriftInput,
): Promise<B3Result<DriftCheckOutcome>> {
  const current = await loadCurrent(deps, input);
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
  const nextEvidence = checkpoint(observed.value, now.toISOString() as IsoUtc);
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
  return b3fail(b3err(
    'UnsupportedOperation',
    'this activity-drift phase is not implemented by the current vertical slice',
    { phase: priorState.phase, quietIntervals: priorState.quietIntervals },
    false,
  ));
}

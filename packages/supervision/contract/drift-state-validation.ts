import type { DurableDriftState } from './drift.js';
import {
  exact,
  finish,
  identifier,
  isoUtc,
  nonEmpty,
  objectValue,
  oneOf,
  stringArray,
  wholeNumber,
  type ObjectValue,
  type ValidationIssue,
} from './validation-support.js';

function forbid(
  object: ObjectValue,
  fields: readonly string[],
  path: string,
  issues: ValidationIssue[],
): void {
  for (const field of fields) {
    if (object[field] !== undefined) {
      issues.push({ path: `${path}.${field}`, message: 'must be absent' });
    }
  }
}

function evidenceCheckpoint(value: unknown, issues: ValidationIssue[]): void {
  const evidence = objectValue(value, 'lastEvidence', issues);
  nonEmpty(evidence.fingerprint, 'lastEvidence.fingerprint', issues);
  oneOf(
    evidence.terminalLiveness,
    ['live', 'exited', 'unknown'],
    'lastEvidence.terminalLiveness',
    issues,
  );
  wholeNumber(
    evidence.terminalActivityGeneration,
    0,
    'lastEvidence.terminalActivityGeneration',
    issues,
  );
  for (const field of ['transcriptWatermark', 'usageActivityDigest', 'usageSourceCursor']) {
    if (evidence[field] !== undefined) nonEmpty(evidence[field], `lastEvidence.${field}`, issues);
  }
  stringArray(evidence.evidenceRefs, 'lastEvidence.evidenceRefs', issues);
  isoUtc(evidence.checkedAt, 'lastEvidence.checkedAt', issues);
}

function closedStatus(value: unknown, issues: ValidationIssue[]): void {
  const status = objectValue(value, 'lastClosedStatus', issues);
  identifier(status.episodeId, 'driftEpisode', 'base32sha256', 'lastClosedStatus.episodeId', issues);
  nonEmpty(status.effectKey, 'lastClosedStatus.effectKey', issues);
  identifier(
    status.notificationId,
    'notification',
    'base32sha256',
    'lastClosedStatus.notificationId',
    issues,
  );
  oneOf(
    status.state,
    ['replied', 'cancelled-before-delivery'],
    'lastClosedStatus.state',
    issues,
  );
  isoUtc(status.closedAt, 'lastClosedStatus.closedAt', issues);
  nonEmpty(status.closureEvidenceRef, 'lastClosedStatus.closureEvidenceRef', issues);
}

function outstandingStatus(
  value: unknown,
  expectedEpisodeId: unknown,
  queuedAllowed: boolean,
  issues: ValidationIssue[],
): void {
  const status = objectValue(value, 'outstandingStatus', issues);
  identifier(status.episodeId, 'driftEpisode', 'base32sha256', 'outstandingStatus.episodeId', issues);
  exact(status.episodeId, expectedEpisodeId, 'outstandingStatus.episodeId', issues);
  nonEmpty(status.effectKey, 'outstandingStatus.effectKey', issues);
  identifier(
    status.notificationId,
    'notification',
    'base32sha256',
    'outstandingStatus.notificationId',
    issues,
  );
  isoUtc(status.requestedAt, 'outstandingStatus.requestedAt', issues);
  if (status.state === 'queued') {
    if (!queuedAllowed) issues.push({ path: 'outstandingStatus.state', message: 'cannot be queued' });
    forbid(
      status,
      ['submittedAt', 'replyDueAt', 'providerTurnId', 'replyEvidenceRef'],
      'outstandingStatus',
      issues,
    );
    return;
  }
  oneOf(
    status.state,
    ['submitted-confirmed', 'submitted-unconfirmed'],
    'outstandingStatus.state',
    issues,
  );
  isoUtc(status.submittedAt, 'outstandingStatus.submittedAt', issues);
  isoUtc(status.replyDueAt, 'outstandingStatus.replyDueAt', issues);
  forbid(status, ['replyEvidenceRef'], 'outstandingStatus', issues);
  if (status.state === 'submitted-confirmed') {
    identifier(
      status.providerTurnId,
      'providerTurn',
      'uuidv7',
      'outstandingStatus.providerTurnId',
      issues,
    );
  } else if (status.providerTurnId !== undefined) {
    identifier(
      status.providerTurnId,
      'providerTurn',
      'uuidv7',
      'outstandingStatus.providerTurnId',
      issues,
    );
  }
}

/** Accumulate exact §9.2 durable drift phase/counter invariants. */
export function validateDurableDriftState(
  value: unknown,
  issues: ValidationIssue[],
): void {
  const state = objectValue(value, 'driftState', issues);
  exact(state.kind, 'activity-drift', 'driftState.kind', issues);
  wholeNumber(state.episodeOrdinal, 0, 'driftState.episodeOrdinal', issues);
  if (state.lastEvidence !== undefined) evidenceCheckpoint(state.lastEvidence, issues);
  if (state.phase === 'observing') {
    oneOf(state.quietIntervals, [0, 1], 'driftState.quietIntervals', issues);
    exact(state.consecutiveUnansweredChecks, 0, 'driftState.consecutiveUnansweredChecks', issues);
    forbid(state, ['outstandingStatus', 'escalationNotificationId'], 'driftState', issues);
    if (state.quietIntervals === 0) forbid(state, ['episodeId'], 'driftState', issues);
    if (state.quietIntervals === 1) {
      identifier(state.episodeId, 'driftEpisode', 'base32sha256', 'driftState.episodeId', issues);
    }
    if (state.lastClosedStatus !== undefined) closedStatus(state.lastClosedStatus, issues);
    return;
  }
  if (state.phase === 'status-outstanding') {
    exact(state.quietIntervals, 2, 'driftState.quietIntervals', issues);
    oneOf(
      state.consecutiveUnansweredChecks,
      [0, 1, 2],
      'driftState.consecutiveUnansweredChecks',
      issues,
    );
    identifier(state.episodeId, 'driftEpisode', 'base32sha256', 'driftState.episodeId', issues);
    outstandingStatus(state.outstandingStatus, state.episodeId, true, issues);
    forbid(state, ['escalationNotificationId', 'lastClosedStatus'], 'driftState', issues);
    return;
  }
  if (state.phase === 'escalated-waiting-human') {
    exact(state.quietIntervals, 2, 'driftState.quietIntervals', issues);
    exact(state.consecutiveUnansweredChecks, 3, 'driftState.consecutiveUnansweredChecks', issues);
    identifier(state.episodeId, 'driftEpisode', 'base32sha256', 'driftState.episodeId', issues);
    outstandingStatus(state.outstandingStatus, state.episodeId, false, issues);
    identifier(
      state.escalationNotificationId,
      'notification',
      'base32sha256',
      'driftState.escalationNotificationId',
      issues,
    );
    forbid(state, ['lastClosedStatus'], 'driftState', issues);
    return;
  }
  issues.push({ path: 'driftState.phase', message: 'is not a durable drift phase' });
}

/** Runtime parser for the exact §9.2 durable drift union. */
export function parseDurableDriftState(candidate: unknown) {
  const issues: ValidationIssue[] = [];
  validateDurableDriftState(candidate, issues);
  return finish<DurableDriftState>(candidate, issues);
}

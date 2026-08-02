import {
  b3fail,
  b3ok,
  isValidId,
  readBoundary,
  validationFailed,
  type ActivityGeneration,
  type AgentId,
  type AgentRunId,
  type EventCursor,
  type FieldReader,
  type IsoUtc,
  type RecordVersion,
  type ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';
import type { HumanPrincipalId } from './shared.js';
import type {
  CheckRunDriftInput,
  ClaimDueDeadlinesInput,
  EvaluateSupervisionEventInput,
  InstallRunWatchersInput,
  NotificationFilter,
  ResetDriftEpisodeInput,
  RecordDriftStatusSubmissionInput,
  NotificationTurnSubmission,
  UpdateWatchRuleInput,
} from './api.js';
import type { VersionedRef } from './policy.js';
import type {
  DriftEpisodeId,
  NotificationId,
  NotificationInputReservationId,
  WatchDeadlineId,
  WatchRuleId,
} from './identifiers.js';
import type { ProviderTurnId, TerminalInputAttemptId } from '@novakai/foundation/contract';
import type { NotificationRecipient } from './records.js';
import { isUrlSafeEventCursor, parsePublicEvent } from './event-validation.js';
import { parseCreateWatchRuleInput } from './validation.js';

function versionedRefs(field: FieldReader): readonly VersionedRef[] {
  const value = field.given('requiredTemplateRefs');
  if (!Array.isArray(value)) {
    field.reject('requiredTemplateRefs', 'must be an array');
    return [];
  }
  return value.map((candidate, index) => {
    const path = `requiredTemplateRefs.${index}`;
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      field.reject(path, 'must be an object');
      return { id: '', version: 0, digest: '' };
    }
    const item = candidate as Readonly<Record<string, unknown>>;
    const id = typeof item.id === 'string' && item.id.trim() !== '' ? item.id : '';
    const digest = typeof item.digest === 'string' && item.digest.trim() !== '' ? item.digest : '';
    const version = item.version;
    if (id === '') field.reject(`${path}.id`, 'must be a non-empty string');
    if (digest === '') field.reject(`${path}.digest`, 'must be a non-empty string');
    if (!Number.isInteger(version) || (version as number) < 1) {
      field.reject(`${path}.version`, 'must be a positive whole number');
    }
    return { id, version: version as number, digest };
  });
}

function positiveBrand<Brand extends number>(
  field: FieldReader,
  path: string,
  least = 1,
): Brand {
  return field.count(path, least, Number.MAX_SAFE_INTEGER) as Brand;
}

function isoUtc(field: FieldReader, path: string): IsoUtc {
  const value = field.text(path);
  if (!value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    field.reject(path, 'must be an ISO-8601 UTC timestamp');
  }
  return value as IsoUtc;
}

/** Runtime parser for spawn's watcher-install input. */
export const parseInstallRunWatchersInput = (
  candidate: unknown,
) => readBoundary<InstallRunWatchersInput>(candidate, (field) => ({
  agentRunId: field.id<AgentRunId>('agentRunId', 'agentRun'),
  launchPlanId: field.id<ResolvedLaunchPlanId>('launchPlanId', 'launchPlan'),
  requiredTemplateRefs: versionedRefs(field),
}));

/** Runtime parser for exact-CAS WatchRule replacement. */
export function parseUpdateWatchRuleInput(candidate: unknown) {
  const envelope = readBoundary<Omit<UpdateWatchRuleInput, 'replacement'>>(
    candidate,
    (field) => ({
      watchRuleId: field.id<WatchRuleId>('watchRuleId', 'watchRule'),
      expectedRecordVersion: positiveBrand<RecordVersion>(field, 'expectedRecordVersion'),
    }),
  );
  if (!envelope.ok) return envelope;
  const body = candidate as Readonly<Record<string, unknown>>;
  const replacement = parseCreateWatchRuleInput(body.replacement);
  if (!replacement.ok) return replacement;
  return b3ok({ ...envelope.value, replacement: replacement.value });
}

/** Runtime parser for a bounded scheduler claim. */
export const parseClaimDueDeadlinesInput = (
  candidate: unknown,
) => readBoundary<ClaimDueDeadlinesInput>(candidate, (field) => ({
  dueBefore: isoUtc(field, 'dueBefore'),
  limit: field.count('limit', 1, Number.MAX_SAFE_INTEGER),
  schedulerLeaseMs: field.count('schedulerLeaseMs', 1, Number.MAX_SAFE_INTEGER),
}));

/** Runtime parser for the fully fenced drift-check input. */
export const parseCheckRunDriftInput = (
  candidate: unknown,
) => readBoundary<CheckRunDriftInput>(candidate, (field) => ({
  watchRuleId: field.id<WatchRuleId>('watchRuleId', 'watchRule'),
  agentRunId: field.id<AgentRunId>('agentRunId', 'agentRun'),
  expectedActivityGeneration: positiveBrand<ActivityGeneration>(
    field,
    'expectedActivityGeneration',
    0,
  ),
  dueDeadlineId: field.id<WatchDeadlineId>(
    'dueDeadlineId',
    'watchDeadline',
    'base32sha256',
  ),
  expectedDeadlineRecordVersion: positiveBrand<RecordVersion>(
    field,
    'expectedDeadlineRecordVersion',
  ),
}));

/** Runtime parser for exact-CAS human drift reset. */
export const parseResetDriftEpisodeInput = (
  candidate: unknown,
) => readBoundary<ResetDriftEpisodeInput>(candidate, (field) => ({
  watchDeadlineId: field.id<WatchDeadlineId>(
    'watchDeadlineId',
    'watchDeadline',
    'base32sha256',
  ),
  expectedRecordVersion: positiveBrand<RecordVersion>(field, 'expectedRecordVersion'),
  expectedEpisodeId: field.id<DriftEpisodeId>(
    'expectedEpisodeId',
    'driftEpisode',
    'base32sha256',
  ),
  reason: field.text('reason'),
}));

/** Runtime parser for Q2's complete Runtime→Supervision submission CAS tuple. */
export function parseRecordDriftStatusSubmissionInput(candidate: unknown) {
  const envelope = readBoundary<Omit<RecordDriftStatusSubmissionInput, 'submission'>>(
    candidate,
    (field) => ({
      watchDeadlineId: field.id<WatchDeadlineId>(
        'watchDeadlineId', 'watchDeadline', 'base32sha256',
      ),
      expectedRecordVersion: positiveBrand<RecordVersion>(field, 'expectedRecordVersion'),
      expectedEpisodeId: field.id<DriftEpisodeId>(
        'expectedEpisodeId', 'driftEpisode', 'base32sha256',
      ),
      expectedEffectKey: field.text('expectedEffectKey'),
      expectedNotificationId: field.id<NotificationId>(
        'expectedNotificationId', 'notification', 'base32sha256',
      ),
      expectedNotificationInputReservationId: field.id<NotificationInputReservationId>(
        'expectedNotificationInputReservationId', 'notificationInput', 'base32sha256',
      ),
      expectedTerminalInputAttemptId: field.id<TerminalInputAttemptId>(
        'expectedTerminalInputAttemptId', 'terminalInput', 'uuidv7',
      ),
    }),
  );
  if (!envelope.ok) return envelope;
  const body = candidate as Readonly<Record<string, unknown>>;
  const submission = readBoundary<NotificationTurnSubmission>(body.submission, (field) => {
    const state = field.choice('state', ['submitted-confirmed', 'submitted-unconfirmed'] as const);
    const rawProviderTurnId = field.given('providerTurnId');
    if (state === 'submitted-confirmed') {
      return {
        state,
        submittedAt: isoUtc(field, 'submittedAt'),
        providerTurnId: field.id<ProviderTurnId>('providerTurnId', 'providerTurn'),
      };
    }
    if (rawProviderTurnId !== undefined
      && !isValidId(rawProviderTurnId, 'providerTurn', 'uuidv7')) {
      field.reject('providerTurnId', 'must be a providerTurn identifier');
    }
    return {
      state,
      submittedAt: isoUtc(field, 'submittedAt'),
      ...(rawProviderTurnId === undefined
        ? {}
        : { providerTurnId: rawProviderTurnId as ProviderTurnId }),
    };
  });
  return submission.ok
    ? b3ok({ ...envelope.value, submission: submission.value })
    : submission;
}

const NOTIFICATION_STATES = [
  'queued', 'offered-to-endpoint', 'transcript-observed',
  'acknowledged', 'delivery-uncertain', 'expired',
] as const;

/** Runtime parser for notification list filters. */
export function parseNotificationFilter(candidate: unknown) {
  return readBoundary<NotificationFilter>(candidate, (field) => {
    const rawStates = field.given('state');
    const states = rawStates === undefined ? undefined : readStates(rawStates, field);
    const cursor = field.optionalText('cursor') as EventCursor | undefined;
    if (cursor !== undefined && !isUrlSafeEventCursor(cursor)) {
      field.reject('cursor', 'must be a non-empty URL-safe string');
    }
    const rawRecipient = field.given('recipient');
    const recipient = rawRecipient === undefined
      ? undefined
      : readRecipient(rawRecipient, field);
    return {
      ...(recipient === undefined ? {} : { recipient }),
      ...(states === undefined ? {} : { state: states }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: field.count('limit', 1, Number.MAX_SAFE_INTEGER),
    };
  });
}

/** Runtime parser for the generic at-least-once evaluateEvent boundary. */
export function parseEvaluateSupervisionEventInput(candidate: unknown) {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return b3fail(validationFailed([{ path: 'payload', message: 'must be an object' }]));
  }
  const event = (candidate as Readonly<Record<string, unknown>>).event;
  const parsed = parsePublicEvent(event);
  return parsed.ok
    ? b3ok<EvaluateSupervisionEventInput>({ event: parsed.value })
    : b3fail(parsed.error);
}

function readRecipient(value: unknown, field: FieldReader): NotificationRecipient {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    field.reject('recipient', 'must be an object');
    return { kind: 'human', principalId: '' as HumanPrincipalId };
  }
  const recipient = value as Readonly<Record<string, unknown>>;
  if (recipient.kind === 'agent') {
    if (!isValidId(recipient.agentId, 'agent', 'uuidv4')) {
      field.reject('recipient.agentId', 'must be an agent identifier');
    }
    return { kind: 'agent', agentId: recipient.agentId as AgentId };
  }
  if (recipient.kind === 'human') {
    if (typeof recipient.principalId !== 'string'
      || !/^person_[A-Za-z0-9-]+$/.test(recipient.principalId)) {
      field.reject('recipient.principalId', 'must be a Messaging PersonId');
    }
    return { kind: 'human', principalId: recipient.principalId as HumanPrincipalId };
  }
  field.reject('recipient.kind', 'must be one of: agent, human');
  return { kind: 'human', principalId: '' as HumanPrincipalId };
}

function readStates(value: unknown, field: FieldReader): NotificationFilter['state'] {
  if (!Array.isArray(value)) {
    field.reject('state', 'must be an array');
    return [];
  }
  const invalid = value.find((item) => !NOTIFICATION_STATES.includes(item as never));
  if (invalid !== undefined) field.reject('state', 'contains an unknown notification state');
  return value as NotificationFilter['state'];
}

/** Runtime validator for a notification identity argument. */
export function parseNotificationId(candidate: unknown) {
  return isValidId(candidate, 'notification', 'base32sha256')
    ? b3ok(candidate)
    : b3fail(validationFailed([{
        path: 'notificationId',
        message: 'must be a notification identifier',
      }]));
}

// The runtime validators for Terminal's public inputs (§3.2, §4.2 MUST).
//
// They live beside the shapes they check, because the capability that owns a
// meaning is the only thing that can say what a valid one looks like. Every
// caller — the wire, the CLI through it, any future host — reads its payload
// through these, so there is one answer to "is this a terminal session id"
// rather than one per surface.
//
// Red gate 3 is the point of the id rules: TerminalSessionId, controller id and
// AgentRunId are NOT interchangeable, and a well-formed body under the wrong
// prefix is rejected on purpose.
import {
  readBoundary,
  type AgentRunId, type B3Result, type EventCursor, type FieldReader,
  type LeaseGeneration, type ProviderTurnId, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  AcquireInputLeaseInput, AttachControllerInput, DetachControllerInput,
  CancelReservedNotificationInput, CommitReservedNotificationInput,
  GetProviderTurnInputAttemptInput, IncompleteProviderTurnInputAttemptFilter,
  OpenManagedTerminalInput, ReadTerminalStreamInput,
  ReleaseInputLeaseInput, ReserveNotificationInput, ResizeTerminalInput,
  TerminalSessionFilter,
  SetControllerDraftStateInput, WriteTerminalInput,
} from './api.js';
import {
  CONTROLLER_KINDS, TERMINAL_INPUT_KINDS, TERMINAL_SESSION_STATUSES,
  type TerminalSessionOwner, type TerminalSessionStatus,
} from './records.js';

/** A terminal is a window on a screen, not an address space. */
const VIEWPORT_LIMIT = 10_000;
const LEASE_TTL_LIMIT_MS = 3_600_000;
const SEQUENCE_LIMIT = Number.MAX_SAFE_INTEGER;

const LEASE_MODES = ['acquire-if-free', 'renew', 'explicit-takeover'] as const;
const OWNER_KINDS = ['plain-shell', 'agent-run'] as const;
const CANCEL_REASONS = ['supervision-claim-rejected', 'runtime-compensation'] as const;
const DRAFT_STATES = ['empty', 'present'] as const;
const SHA256 = /^[0-9a-f]{64}$/u;

/** The owner is a union, so its tag decides which id has to be valid. */
function readOwner(field: FieldReader): TerminalSessionOwner {
  const owner = field.nested('owner');
  const kind = owner.choice('kind', OWNER_KINDS);
  if (kind === 'agent-run') {
    return { kind, agentRunId: owner.id('agentRunId', 'agentRun') };
  }
  return { kind: 'plain-shell', shellInstanceId: owner.text('shellInstanceId') };
}

function readViewport(field: FieldReader): { columns: number; rows: number } {
  return {
    columns: field.count('columns', 1, VIEWPORT_LIMIT),
    rows: field.count('rows', 1, VIEWPORT_LIMIT),
  };
}

export function readOpenManagedTerminalInput(
  payload: unknown,
): B3Result<OpenManagedTerminalInput> {
  return readBoundary(payload, (field) => ({
    owner: readOwner(field),
    launchAuthorityRef: field.text('launchAuthorityRef'),
    launchFingerprint: field.text('launchFingerprint'),
    workingDirectory: field.text('workingDirectory'),
    ...readViewport(field),
  }));
}

export function readAttachControllerInput(payload: unknown): B3Result<AttachControllerInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    controllerKind: field.choice('controllerKind', CONTROLLER_KINDS),
    ...readViewport(field),
    ...optional('afterOutputSequence', field.optionalCount('afterOutputSequence', 0, SEQUENCE_LIMIT)),
  }));
}

export function readDetachControllerInput(payload: unknown): B3Result<DetachControllerInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    attachmentId: field.id('attachmentId', 'controller'),
  }));
}

export function readAcquireInputLeaseInput(payload: unknown): B3Result<AcquireInputLeaseInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    attachmentId: field.id('attachmentId', 'controller'),
    mode: field.choice('mode', LEASE_MODES),
    ttlMs: field.count('ttlMs', 1, LEASE_TTL_LIMIT_MS),
    ...optional('expectedLeaseGeneration',
      field.optionalCount('expectedLeaseGeneration', 1, SEQUENCE_LIMIT) as
        LeaseGeneration | undefined),
  }));
}

export function readReleaseInputLeaseInput(payload: unknown): B3Result<ReleaseInputLeaseInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    attachmentId: field.id('attachmentId', 'controller'),
    leaseId: field.id('leaseId', 'terminalInputLease'),
    generation: field.count('generation', 1, SEQUENCE_LIMIT) as LeaseGeneration,
  }));
}

function sha256(field: FieldReader, name: string): string {
  const value = field.given(name);
  if (typeof value !== 'string' || !SHA256.test(value)) {
    field.reject(name, 'must be 64 lowercase hexadecimal characters');
    return '';
  }
  return value;
}

export function readReserveNotificationInput(
  payload: unknown,
): B3Result<ReserveNotificationInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    agentRunId: field.id('agentRunId', 'agentRun'),
    notificationId: field.id('notificationId', 'notification', 'base32sha256'),
    effectKey: field.text('effectKey'),
    expectedActivityGeneration: field.count(
      'expectedActivityGeneration', 0, SEQUENCE_LIMIT,
    ) as never,
    inputTextDigest: sha256(field, 'inputTextDigest'),
    providerTurnId: field.id('providerTurnId', 'providerTurn'),
  }));
}

export function readCommitReservedNotificationInput(
  payload: unknown,
): B3Result<CommitReservedNotificationInput> {
  return readBoundary(payload, (field) => ({
    notificationInputReservationId: field.id(
      'notificationInputReservationId', 'notificationInput', 'base32sha256',
    ),
    effectKey: field.text('effectKey'),
    utf8Text: field.text('utf8Text'),
  }));
}

export function readCancelReservedNotificationInput(
  payload: unknown,
): B3Result<CancelReservedNotificationInput> {
  return readBoundary(payload, (field) => ({
    notificationInputReservationId: field.id(
      'notificationInputReservationId', 'notificationInput', 'base32sha256',
    ),
    effectKey: field.text('effectKey'),
    reason: field.choice('reason', CANCEL_REASONS),
  }));
}

export function readSetControllerDraftStateInput(
  payload: unknown,
): B3Result<SetControllerDraftStateInput> {
  return readBoundary(payload, (field) => ({
    attachmentId: field.id('attachmentId', 'controller'),
    expectedDraftGeneration: field.count('expectedDraftGeneration', 0, SEQUENCE_LIMIT),
    state: field.choice('state', DRAFT_STATES),
  }));
}

export function readWriteTerminalInput(payload: unknown): B3Result<WriteTerminalInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    attachmentId: field.id('attachmentId', 'controller'),
    inputLeaseId: field.id('inputLeaseId', 'terminalInputLease'),
    leaseGeneration: field.count('leaseGeneration', 1, SEQUENCE_LIMIT) as LeaseGeneration,
    ...optional('expectedNextInputSequence', readSequenceClaim(field)),
    kindOfInput: field.choice('kindOfInput', [...TERMINAL_INPUT_KINDS, 'provider-turn-submit']),
    // Bytes are not validated for content — a terminal accepts what you type.
    ...optional('utf8Text', typeof field.given('utf8Text') === 'string'
      ? field.given('utf8Text') as string : undefined),
  }));
}

export function readGetProviderTurnInputAttemptInput(
  payload: unknown,
): B3Result<GetProviderTurnInputAttemptInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id<TerminalSessionId>('terminalSessionId', 'terminal'),
    providerTurnId: field.id<ProviderTurnId>('providerTurnId', 'providerTurn'),
    submissionEffectKey: field.text('submissionEffectKey'),
  }));
}

export function readIncompleteProviderTurnInputAttemptFilter(
  payload: unknown,
): B3Result<IncompleteProviderTurnInputAttemptFilter> {
  return readBoundary(payload, (field) => {
    const terminalSessionId = field.optionalId<TerminalSessionId>('terminalSessionId', 'terminal');
    const agentRunId = field.optionalId<AgentRunId>('agentRunId', 'agentRun');
    const states = field.given('states');
    const allowed = ['prepared', 'executing', 'submitted-confirmed', 'submitted-unconfirmed'] as const;
    const validStates = states === undefined
      ? undefined
      : Array.isArray(states) && states.every((state) => allowed.includes(state as never))
        ? states as IncompleteProviderTurnInputAttemptFilter['states']
        : undefined;
    if (states !== undefined && validStates === undefined) {
      field.reject('states', `must be an array of: ${allowed.join(', ')}`);
    }
    const cursor = field.optionalText('cursor');
    return {
      ...(terminalSessionId === undefined ? {} : { terminalSessionId }),
      ...(agentRunId === undefined ? {} : { agentRunId }),
      ...(validStates === undefined ? {} : { states: validStates }),
      ...(cursor === undefined ? {} : { cursor: cursor as never }),
      limit: field.count('limit', 1, 200),
    };
  });
}

/**
 * The position this write claims, if it claims one.
 *
 * The claim is OPTIONAL because the published contract gives a client no way to
 * learn the position: `WriteTerminalInput` requires the field and nothing in
 * the spec's terminal surface returns it — not the session view, not the
 * attachment, not the lease. (`nextInputSequence` on the view is this
 * repository's own addition.) Requiring a number nobody can obtain made every
 * conformant client's FIRST write impossible, which is the same unwinnable
 * shape the conflict branch was repaired for.
 *
 * Absent means "append where the stream is". That is not a hole in the ordering
 * rule: the INPUT LEASE is what makes a writer exclusive, and this check sits
 * on top of it for callers that are tracking the position themselves. Those
 * callers keep it, exactly as before.
 *
 * A malformed claim is still a refusal, and it says both what it received and
 * how to proceed — the message it used to share with an omitted field told a
 * client nothing about which of the two mistakes it had made.
 */
function readSequenceClaim(field: FieldReader): number | undefined {
  const given = field.given('expectedNextInputSequence');
  if (given === undefined) return undefined;
  if (typeof given !== 'number' || !Number.isInteger(given)
    || given < 0 || given > SEQUENCE_LIMIT) {
    field.reject('expectedNextInputSequence',
      `must be a whole number between 0 and ${String(SEQUENCE_LIMIT)} `
      + `(received ${JSON.stringify(given) ?? 'undefined'}) — or omit it to append `
      + 'at the current position');
    return undefined;
  }
  return given;
}

export function readResizeTerminalInput(payload: unknown): B3Result<ResizeTerminalInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    attachmentId: field.id('attachmentId', 'controller'),
    ...readViewport(field),
  }));
}

export function readReadTerminalStreamInput(payload: unknown): B3Result<ReadTerminalStreamInput> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id('terminalSessionId', 'terminal'),
    ...optional('afterOutputSequence',
      field.optionalCount('afterOutputSequence', 0, SEQUENCE_LIMIT)),
  }));
}

export function readTerminalSessionIdInput(
  payload: unknown,
): B3Result<{ readonly terminalSessionId: TerminalSessionId }> {
  return readBoundary(payload, (field) => ({
    terminalSessionId: field.id<TerminalSessionId>('terminalSessionId', 'terminal'),
  }));
}

/**
 * A5-05: `status` is a set, not one value — "show me everything that is not
 * finished" is one question, and asking it as three separate calls is how two
 * pages of one truth get compared.
 */
function readStatuses(field: FieldReader): readonly TerminalSessionStatus[] | undefined {
  const given = field.given('status');
  if (given === undefined) return undefined;
  if (!Array.isArray(given) || given.length === 0
    || !given.every((item) => TERMINAL_SESSION_STATUSES.includes(item as TerminalSessionStatus))) {
    field.reject('status', `must be a non-empty array of: ${TERMINAL_SESSION_STATUSES.join(', ')}`);
    return undefined;
  }
  return given as readonly TerminalSessionStatus[];
}

export function readTerminalSessionFilter(
  payload: unknown,
): B3Result<TerminalSessionFilter> {
  return readBoundary(payload, (field) => ({
    ...(field.given('owner') === undefined ? {} : { owner: readOwner(field) }),
    ...optional('status', readStatuses(field)),
    ...optional('cursor', field.optionalText('cursor') as EventCursor | undefined),
    limit: field.count('limit', 1, 200),
  }));
}

/** Absent stays absent: an optional field is not the same as an undefined one. */
function optional<Name extends string, Value>(
  name: Name, value: Value | undefined,
): Record<Name, Value> | Record<string, never> {
  return value === undefined ? {} : { [name]: value } as Record<Name, Value>;
}

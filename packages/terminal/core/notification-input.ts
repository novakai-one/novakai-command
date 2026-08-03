// Q7's Terminal-owned reservation for one watcher-originated provider input.
//
// The record is the keyboard fence. While it is `reserved`, neither a human
// lease nor a controller draft may start, and only the matching commit/cancel
// command can end it. Commit writes at most once: an unconfirmed attempt is
// durable before touching the PTY, so recovery adopts uncertainty instead of
// gambling on a duplicate turn.
import {
  b3err, b3fail, b3ok, mintClientOpId,
  notificationInputReservationId, type B3Result, type CommandContext,
  type NotificationInputReservationId, type RecordVersion,
  type SystemCommandContext, type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import type {
  CancelReservedNotificationInput, ReserveNotificationInput, SetControllerDraftStateInput,
} from '../contract/api.js';
import type {
  ControllerAttachment, NotificationInputReservation, TerminalInputAttempt,
} from '../contract/records.js';
import { requireOwnAttachment } from './authority.js';
import { clockIso, OPERATION, requireLiveSession, type TerminalCore } from './context.js';
import { settleAndFindActive } from './leases.js';
import {
  activeNotificationReservation, notificationAttemptFor,
} from './notification-reservation-state.js';
import type { Persisted } from './store.js';

const SHA256 = /^[0-9a-f]{64}$/u;

export { commitReservedNotificationInput } from './notification-input-commit.js';
export { activeNotificationReservation } from './notification-reservation-state.js';

const reservationConflict = (
  message: string, details: Readonly<Record<string, unknown>>,
) => b3err('IdempotencyConflict', message, details, false);

const busy = (details: Readonly<Record<string, unknown>>) => b3err(
  'InputLeaseBusy', 'the terminal input boundary is fenced', details, true,
);

function sameReservation(
  record: NotificationInputReservation, input: ReserveNotificationInput,
): boolean {
  return record.terminalSessionId === input.terminalSessionId
    && record.agentRunId === input.agentRunId
    && record.notificationId === input.notificationId
    && record.deliveryEffectKey === input.effectKey
    && Number(record.expectedActivityGeneration) === Number(input.expectedActivityGeneration)
    && record.inputTextDigest === input.inputTextDigest
    && record.providerTurnId === input.providerTurnId;
}

async function requireAvailableBoundary(
  core: TerminalCore, input: ReserveNotificationInput, sessionStatus: string,
): Promise<B3Result<null>> {
  const activeLease = await settleAndFindActive(core, input.terminalSessionId);
  if (!activeLease.ok) return activeLease;
  if (activeLease.value !== null) {
    return b3fail(busy({
      reason: 'active-input-lease', holderAttachmentId: activeLease.value.attachmentId,
    }));
  }
  const attachments = await core.store.list<ControllerAttachment>(
    'controllerAttachment', { terminalSessionId: input.terminalSessionId },
  );
  if (!attachments.ok) return attachments;
  const draft = attachments.value.find(
    (item) => item.state === 'attached' && item.draftState === 'present',
  );
  if (draft !== undefined) {
    return b3fail(busy({ reason: 'controller-draft-present', attachmentId: draft.id }));
  }
  const prior = await activeNotificationReservation(core, input.terminalSessionId);
  if (!prior.ok) return prior;
  if (prior.value !== null) {
    return b3fail(busy({
      reason: 'notification-input-reserved',
      notificationInputReservationId: prior.value.id,
    }));
  }
  const live = core.live.lookup(input.terminalSessionId);
  if (live === undefined) {
    return b3fail(b3err('TerminalNotLive', 'the terminal has no live process', {
      terminalSessionId: input.terminalSessionId, status: sessionStatus,
    }, false));
  }
  return live.activeTurn === null
    ? b3ok(null)
    : b3fail(busy({ reason: 'provider-turn-active' }));
}

export async function reserveNotificationInput(
  core: TerminalCore,
  _context: SystemCommandContext<'sys_agent_runtime'>,
  input: ReserveNotificationInput,
): Promise<B3Result<NotificationInputReservation>> {
  if (!SHA256.test(input.inputTextDigest)) {
    return b3fail(b3err('ValidationFailed', 'inputTextDigest must be lowercase SHA-256', {
      issues: [{ path: 'inputTextDigest', message: 'must be 64 lowercase hex characters' }],
    }, false));
  }
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  if (session.value.owner.kind !== 'agent-run'
    || session.value.owner.agentRunId !== input.agentRunId) {
    return b3fail(b3err('NotificationDeliveryUnsafe',
      'the notification target does not own this terminal session', {
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
      }, false));
  }

  const id = notificationInputReservationId(input.effectKey);
  const existing = await core.store.read<NotificationInputReservation>(
    'notificationInputReservation', id,
  );
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    return sameReservation(existing.value, input)
      ? b3ok(existing.value)
      : b3fail(reservationConflict('reservation identity is bound to different input facts', {
          notificationInputReservationId: id,
        }));
  }

  const available = await requireAvailableBoundary(core, input, session.value.status);
  if (!available.ok) return available;

  const record: Persisted<NotificationInputReservation> = {
    kind: 'notificationInputReservation',
    id,
    schemaVersion: 1,
    createdAt: clockIso(core),
    permissionLevel: 'private',
    createdBy: 'sys_terminal',
    terminalSessionId: input.terminalSessionId,
    agentRunId: input.agentRunId,
    notificationId: input.notificationId,
    deliveryEffectKey: input.effectKey,
    expectedActivityGeneration: input.expectedActivityGeneration,
    inputTextDigest: input.inputTextDigest,
    providerTurnId: input.providerTurnId,
    state: 'reserved',
  };
  return core.store.create<NotificationInputReservation>(
    'sys_terminal', record, mintClientOpId(),
  );
}

export async function cancelReservedNotificationInput(
  core: TerminalCore,
  _context: SystemCommandContext<'sys_agent_runtime'>,
  input: CancelReservedNotificationInput,
): Promise<B3Result<NotificationInputReservation>> {
  const stored = await core.store.read<NotificationInputReservation>(
    'notificationInputReservation', input.notificationInputReservationId,
  );
  if (!stored.ok) return stored;
  const reservation = stored.value;
  if (reservation === null) {
    return b3fail(b3err('ValidationFailed', 'unknown notification input reservation', {
      notificationInputReservationId: input.notificationInputReservationId,
    }, false));
  }
  if (reservation.deliveryEffectKey !== input.effectKey) {
    return b3fail(reservationConflict('effect key does not own this reservation', {
      notificationInputReservationId: reservation.id,
    }));
  }
  if (reservation.state === 'cancelled') {
    return reservation.cancelReason === input.reason
      ? b3ok(reservation)
      : b3fail(reservationConflict('reservation was cancelled for another reason', {
          notificationInputReservationId: reservation.id,
        }));
  }
  if (reservation.state === 'committed') {
    return b3fail(reservationConflict('a committed reservation cannot be cancelled', {
      notificationInputReservationId: reservation.id,
    }));
  }
  const attempt = await notificationAttemptFor(core, reservation.id);
  if (!attempt.ok) return attempt;
  if (attempt.value !== null) {
    return b3fail(reservationConflict('a reservation with a Terminal attempt cannot be cancelled', {
      notificationInputReservationId: reservation.id,
    }));
  }
  return core.store.update<NotificationInputReservation>(
    'sys_terminal', 'notificationInputReservation', reservation.id,
    { state: 'cancelled', endedAt: clockIso(core), cancelReason: input.reason },
    reservation.recordVersion, mintClientOpId(),
  );
}

export async function setControllerDraftState(
  core: TerminalCore, context: CommandContext, input: SetControllerDraftStateInput,
): Promise<B3Result<ControllerAttachment>> {
  const attachment = await core.store.read<ControllerAttachment>(
    'controllerAttachment', input.attachmentId,
  );
  if (!attachment.ok) return attachment;
  if (attachment.value === null || attachment.value.state !== 'attached') {
    return b3fail(b3err('ValidationFailed', 'draft state requires an attached controller', {
      issues: [{ path: 'attachmentId', message: 'not an attached controller' }],
    }, false));
  }
  const allowed = requireOwnAttachment(context, attachment.value, OPERATION.draft);
  if (!allowed.ok) return allowed;
  const generation = attachment.value.draftGeneration ?? 0;
  if (generation !== input.expectedDraftGeneration) {
    return b3fail(b3err('VersionConflict', 'controller draft generation moved', {
      objectId: attachment.value.id,
      expected: input.expectedDraftGeneration,
      actual: generation,
    }, true));
  }
  if (input.state === 'present') {
    const reserved = await activeNotificationReservation(core, attachment.value.terminalSessionId);
    if (!reserved.ok) return reserved;
    if (reserved.value !== null) {
      return b3fail(busy({
        reason: 'notification-input-reserved',
        notificationInputReservationId: reserved.value.id,
      }));
    }
  }
  return core.store.update<ControllerAttachment>(
    context.principal.id, 'controllerAttachment', attachment.value.id,
    { draftState: input.state, draftGeneration: generation + 1 },
    attachment.value.recordVersion as RecordVersion, mintClientOpId(),
  );
}

export async function getNotificationInputReservation(
  core: TerminalCore, id: NotificationInputReservationId,
): Promise<B3Result<NotificationInputReservation>> {
  const found = await core.store.read<NotificationInputReservation>(
    'notificationInputReservation', id,
  );
  return found.ok && found.value === null
    ? b3fail(b3err('ValidationFailed', 'unknown notification input reservation', { id }, false))
    : found as B3Result<NotificationInputReservation>;
}

export async function getTerminalInputAttempt(
  core: TerminalCore, id: TerminalInputAttemptId,
): Promise<B3Result<TerminalInputAttempt>> {
  const found = await core.store.read<TerminalInputAttempt>('terminalInputAttempt', id);
  return found.ok && found.value === null
    ? b3fail(b3err('ValidationFailed', 'unknown Terminal input attempt', { id }, false))
    : found as B3Result<TerminalInputAttempt>;
}

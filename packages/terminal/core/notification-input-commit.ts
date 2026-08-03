// Commit one Terminal-owned Notification reservation without repeating bytes.
import { createHash } from 'node:crypto';
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTerminalInputAttemptId,
  type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  CommitReservedNotificationInput, NotificationInputCommitOutcome,
} from '../contract/api.js';
import type { NotificationInputReservation } from '../contract/records.js';
import { clockIso, requireLiveSession, type TerminalCore } from './context.js';
import {
  activeNotificationReservation, finishNotificationReservation,
  notificationAttemptFor, type NotificationAttempt, type ReservedNotificationInput,
} from './notification-reservation-state.js';
import type { Persisted } from './store.js';

const SUBMIT_KEY = '\r';
const COMPOSER_BEAT_MS = 250;

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('IdempotencyConflict', message, details, false);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const pause = async (): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, COMPOSER_BEAT_MS); });
};

function logicalText(utf8Text: string): B3Result<string> {
  if (!utf8Text.endsWith(SUBMIT_KEY) || utf8Text.length === 1) {
    return b3fail(b3err('ValidationFailed',
      'reserved notification input must end with one provider submit key', {
        issues: [{ path: 'utf8Text', message: 'must contain text followed by carriage return' }],
      }, false));
  }
  return b3ok(utf8Text.slice(0, -1));
}

interface CommitFacts {
  readonly reservation: Exclude<NotificationInputReservation, { readonly state: 'cancelled' }>;
  readonly text: string;
}

async function loadCommitFacts(
  core: TerminalCore, input: CommitReservedNotificationInput,
): Promise<B3Result<CommitFacts>> {
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
    return b3fail(conflict('effect key does not own this reservation', {
      notificationInputReservationId: reservation.id,
    }));
  }
  if (reservation.state === 'cancelled') {
    return b3fail(conflict('a cancelled reservation cannot be committed', {
      notificationInputReservationId: reservation.id,
    }));
  }
  const text = logicalText(input.utf8Text);
  if (!text.ok) return text;
  if (sha256(text.value) !== reservation.inputTextDigest) {
    return b3fail(conflict('input bytes do not match the reserved logical text', {
      notificationInputReservationId: reservation.id,
    }));
  }
  return b3ok({ reservation, text: text.value });
}

type AttemptAdoption =
  | { readonly kind: 'complete'; readonly outcome: NotificationInputCommitOutcome }
  | { readonly kind: 'write'; readonly reservation: ReservedNotificationInput };

async function adoptAttempt(
  core: TerminalCore,
  reservation: CommitFacts['reservation'],
  prior: NotificationAttempt | null,
): Promise<B3Result<AttemptAdoption>> {
  if (reservation.state === 'committed') {
    if (prior === null || prior.id !== reservation.terminalInputAttemptId) {
      return b3fail(b3err('RecoveryRequired',
        'committed notification reservation has no matching Terminal attempt', {
          notificationInputReservationId: reservation.id,
          terminalInputAttemptId: reservation.terminalInputAttemptId,
        }, true));
    }
    return b3ok({ kind: 'complete', outcome: { reservation, attempt: prior } });
  }
  if (prior === null) return b3ok({ kind: 'write', reservation });
  const finished = await finishNotificationReservation(core, reservation, prior.id);
  return finished.ok
    ? b3ok({ kind: 'complete', outcome: { reservation: finished.value, attempt: prior } })
    : finished;
}

async function writeAttempt(
  core: TerminalCore, reservation: ReservedNotificationInput, text: string,
): Promise<B3Result<NotificationInputCommitOutcome>> {
  const session = await requireLiveSession(core, reservation.terminalSessionId);
  if (!session.ok) return session;
  const active = await activeNotificationReservation(core, reservation.terminalSessionId);
  if (!active.ok) return active;
  if (active.value?.id !== reservation.id) {
    return b3fail(conflict('reservation no longer holds the terminal input fence', {
      notificationInputReservationId: reservation.id,
    }));
  }
  const live = core.live.lookup(reservation.terminalSessionId);
  if (live === undefined) {
    return b3fail(b3err('TerminalNotLive', 'the reserved terminal has no live process', {
      terminalSessionId: reservation.terminalSessionId, status: session.value.status,
    }, false));
  }
  const submittedAt = clockIso(core);
  const attemptRecord: Persisted<NotificationAttempt> = {
    kind: 'terminalInputAttempt',
    id: mintTerminalInputAttemptId(),
    schemaVersion: 1,
    createdAt: submittedAt,
    permissionLevel: 'private',
    createdBy: 'sys_terminal',
    source: 'system-notification',
    terminalSessionId: reservation.terminalSessionId,
    notificationInputReservationId: reservation.id,
    deliveryEffectKey: reservation.deliveryEffectKey,
    providerTurnId: reservation.providerTurnId,
    inputSequence: live.nextInputSequence,
    payloadDigest: reservation.inputTextDigest,
    kindOfInput: 'message-delivery',
    outcome: 'submitted-unconfirmed',
    submittedAt,
  };
  const pending = await core.store.create<NotificationAttempt>(
    'sys_terminal', attemptRecord, mintClientOpId(),
  );
  if (!pending.ok) return pending;
  live.nextInputSequence += 1;
  let attempt = pending.value;
  try {
    live.pty.write(text);
    await pause();
    live.pty.write(SUBMIT_KEY);
    const confirmed = await core.store.update<NotificationAttempt>(
      'sys_terminal', 'terminalInputAttempt', attempt.id,
      { outcome: 'submitted-confirmed' },
      attempt.recordVersion, mintClientOpId(),
    );
    if (confirmed.ok) attempt = confirmed.value;
  } catch {
    // The pre-write record is intentionally unconfirmed. Never retype it.
  }
  const finished = await finishNotificationReservation(core, reservation, attempt.id);
  return finished.ok ? b3ok({ reservation: finished.value, attempt }) : finished;
}

export async function commitReservedNotificationInput(
  core: TerminalCore,
  _context: SystemCommandContext<'sys_agent_runtime'>,
  input: CommitReservedNotificationInput,
): Promise<B3Result<NotificationInputCommitOutcome>> {
  const facts = await loadCommitFacts(core, input);
  if (!facts.ok) return facts;
  const prior = await notificationAttemptFor(core, facts.value.reservation.id);
  if (!prior.ok) return prior;
  const adoption = await adoptAttempt(core, facts.value.reservation, prior.value);
  if (!adoption.ok) return adoption;
  return adoption.value.kind === 'complete'
    ? b3ok(adoption.value.outcome)
    : writeAttempt(core, adoption.value.reservation, facts.value.text);
}

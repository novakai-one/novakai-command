// LANE C — the delivery half of the Notification seam.
//
// Watchers EMIT a queued Notification through the frozen contract; this
// consumes it. The whole risk of the slice lives in three sentences of §13.8:
// "Queue commit occurs before any delivery action", "`queue-only` never starts
// a turn", and "`start-turn` never steals input, interrupts a turn, or polls a
// model". Nothing here can start a turn even by accident — it holds a store and
// its own contract, and has no way to reach a PTY. Runtime performs the effect;
// this owns only the durable truth on either side of it.
//
// The other law, from Q11: a Terminal submission is evidence of the INPUT
// EFFECT, not evidence that the provider transcript contains that turn. So no
// path here advances a Notification past `offered-to-endpoint`. Only Transcript,
// holding positive per-turn evidence, may do that.
import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type AgentRunId, type AuthenticatedPrincipal,
  type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type ClaimNotificationDeliveryInput, type Notification,
  type NotificationDeliveryAuthority, type NotificationDeliveryClaim,
  type NotificationId, type RecordNotificationDeliveryOutcomeInput,
  type WatchRule,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';

export interface DeliveryDependencies {
  readonly store: SupervisionStore;
}

type RuntimeContext = SystemCommandContext<'sys_agent_runtime'>;

/** The delivery modes that produce a durable provider input attempt at all. */
const ATTEMPTED_MODES: readonly Notification['deliveryMode'][] = [
  'next-turn-context', 'start-turn',
];

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('IdempotencyConflict', message, details, false);

const unsafe = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('NotificationDeliveryUnsafe', message, details, false);

const unknown = (notificationId: NotificationId) =>
  b3err('ValidationFailed', 'unknown notification', { notificationId }, false);

const versionConflict = (
  notificationId: NotificationId, expected: number, actual: number,
) => b3err(
  'VersionConflict',
  'notification record version moved under this delivery',
  { notificationId, expected, actual },
  true,
);

/** Read one Notification and refuse anything whose effect key is not its own. */
async function loadForEffect(
  deps: DeliveryDependencies,
  notificationId: NotificationId,
  expectedEffectKey: string,
): Promise<B3Result<Notification>> {
  const stored = await deps.store.read<Notification>('notification', notificationId);
  if (!stored.ok) return b3fail(stored.error);
  if (stored.value === null) return b3fail(unknown(notificationId));
  if (stored.value.deliveryEffectKey !== expectedEffectKey) {
    return b3fail(conflict('delivery effect key does not identify this notification', {
      notificationId, expectedEffectKey, actualEffectKey: stored.value.deliveryEffectKey,
    }));
  }
  return b3ok(stored.value);
}

/** The reservation currently bound to a Notification, or null while queued. */
function boundReservation(notification: Notification): string | null {
  const attempt = notification.deliveryAttempt;
  return attempt.state === 'queued' ? null : attempt.notificationInputReservationId;
}

/**
 * Bind one queued Notification to one Terminal reservation, exactly once.
 *
 * The idempotent replay is checked BEFORE the CAS, deliberately. A duplicate
 * delivery replays the ORIGINAL request — including the record version it read
 * before the first claim landed — so version-checking first would turn every
 * honest retry into a conflict and every conflict into a second turn. The
 * reservation is the identity that makes the retry safe; the version is what
 * stops a DIFFERENT reservation from overwriting it.
 */
export async function claimNotificationDelivery(
  deps: DeliveryDependencies,
  _context: RuntimeContext,
  input: ClaimNotificationDeliveryInput,
): Promise<B3Result<NotificationDeliveryClaim>> {
  const loaded = await loadForEffect(deps, input.notificationId, input.expectedEffectKey);
  if (!loaded.ok) return b3fail(loaded.error);
  const notification = loaded.value;

  if (!ATTEMPTED_MODES.includes(notification.deliveryMode)) {
    return b3fail(unsafe('queue-only notifications have no provider delivery effect', {
      notificationId: notification.id, deliveryMode: notification.deliveryMode,
    }));
  }

  // Same reservation, any version: this is the same delivery, replayed.
  if (boundReservation(notification) === input.notificationInputReservationId) {
    return b3ok({ notification });
  }

  if (Number(notification.recordVersion) !== Number(input.expectedNotificationRecordVersion)) {
    return b3fail(versionConflict(
      notification.id,
      Number(input.expectedNotificationRecordVersion),
      Number(notification.recordVersion),
    ));
  }

  if (notification.deliveryAttempt.state !== 'queued') {
    return b3fail(conflict('notification delivery is already claimed by another reservation', {
      notificationId: notification.id,
      heldBy: boundReservation(notification),
      requestedBy: input.notificationInputReservationId,
    }));
  }

  const written = await deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notification.id,
    {
      state: 'offered-to-endpoint',
      deliveryAttempt: {
        state: 'delivery-claimed',
        effectKey: notification.deliveryEffectKey,
        claimedAt: nowIsoUtc(),
        notificationInputReservationId: input.notificationInputReservationId,
      },
    },
    notification.recordVersion,
    deriveClientOpId(
      `b3v4:claim-notification-delivery:${notification.id}:${input.notificationInputReservationId}`,
    ),
  );
  if (!written.ok) return b3fail(written.error);
  return b3ok({ notification: written.value });
}

/** True when this outcome has already been durably recorded, verbatim. */
function alreadyRecorded(
  notification: Notification,
  input: RecordNotificationDeliveryOutcomeInput,
): boolean {
  const attempt = notification.deliveryAttempt;
  if (attempt.state !== input.outcome.state) return false;
  return attempt.terminalInputAttemptId === input.terminalInputAttemptId;
}

/**
 * Record what Terminal observed of one submission — and stop there.
 *
 * A confirmed submission proves the input reached the provider. It does not
 * prove the provider's transcript contains that turn, so this NEVER writes
 * `transcript-observed`, and it never writes `delivery-uncertain` either: Q11
 * reserves that for Transcript's durable negative closure evidence. Missing
 * evidence does not become positive — or negative — by elapsed time.
 */
export async function recordNotificationDeliveryOutcome(
  deps: DeliveryDependencies,
  _context: RuntimeContext,
  input: RecordNotificationDeliveryOutcomeInput,
): Promise<B3Result<Notification>> {
  const loaded = await loadForEffect(deps, input.notificationId, input.expectedEffectKey);
  if (!loaded.ok) return b3fail(loaded.error);
  const notification = loaded.value;

  if (boundReservation(notification) !== input.notificationInputReservationId) {
    return b3fail(conflict('this reservation does not hold the notification delivery', {
      notificationId: notification.id,
      heldBy: boundReservation(notification),
      requestedBy: input.notificationInputReservationId,
    }));
  }

  if (alreadyRecorded(notification, input)) return b3ok(notification);

  if (Number(notification.recordVersion) !== Number(input.expectedRecordVersion)) {
    return b3fail(versionConflict(
      notification.id, Number(input.expectedRecordVersion), Number(notification.recordVersion),
    ));
  }

  const written = await deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notification.id,
    {
      deliveryAttempt: {
        state: input.outcome.state,
        effectKey: notification.deliveryEffectKey,
        submittedAt: input.outcome.submittedAt,
        notificationInputReservationId: input.notificationInputReservationId,
        terminalInputAttemptId: input.terminalInputAttemptId,
        ...(input.outcome.providerTurnId === undefined
          ? {}
          : { providerTurnId: input.outcome.providerTurnId }),
      },
    },
    notification.recordVersion,
    deriveClientOpId(
      `b3v4:notification-delivery-outcome:${notification.id}:${input.terminalInputAttemptId}`,
    ),
  );
  if (!written.ok) return b3fail(written.error);
  return b3ok(written.value);
}

/** The Run a Notification's delivery would target, when it names one at all. */
function runOf(notification: Notification): AgentRunId | null {
  return notification.subject.kind === 'agent-run' ? notification.subject.agentRunId : null;
}

/**
 * Publish the authority for a `start-turn` delivery, resolved from the durable
 * rule rather than accepted from the caller.
 *
 * This answers "may a turn be started for this, and with what text" — it does
 * not answer "is it safe right now". The idle-Run and controller-lease
 * conditions in §13.8 are Runtime/Terminal-owned facts this capability cannot
 * see, and the safe boundary remains Runtime's to find.
 */
export async function getNotificationDeliveryAuthority(
  deps: DeliveryDependencies,
  _principal: AuthenticatedPrincipal,
  notificationId: NotificationId,
): Promise<B3Result<NotificationDeliveryAuthority>> {
  const stored = await deps.store.read<Notification>('notification', notificationId);
  if (!stored.ok) return b3fail(stored.error);
  if (stored.value === null) return b3fail(unknown(notificationId));
  const notification = stored.value;

  if (notification.deliveryMode !== 'start-turn') {
    return b3fail(unsafe('only start-turn deliveries carry authority to cause a turn', {
      notificationId, deliveryMode: notification.deliveryMode,
    }));
  }

  const agentRunId = runOf(notification);
  if (agentRunId === null) {
    return b3fail(unsafe('a start-turn delivery must name the Run it would speak into', {
      notificationId, subject: notification.subject.kind,
    }));
  }

  const rule = await deps.store.read<WatchRule>('watchRule', notification.watchRuleId);
  if (!rule.ok) return b3fail(rule.error);
  if (rule.value === null) {
    return b3fail(unsafe('the rule that authorised this delivery no longer exists', {
      notificationId, watchRuleId: notification.watchRuleId,
    }));
  }

  const installation = rule.value.installation;
  return b3ok({
    notificationId,
    notificationRecordVersion: notification.recordVersion,
    watchRuleId: notification.watchRuleId,
    agentRunId,
    deliveryEffectKey: notification.deliveryEffectKey,
    activityGeneration: notification.conditionGeneration as unknown as ActivityGeneration,
    deliveryMode: 'start-turn',
    inputText: notification.summary,
    authoritySource: installation === undefined
      ? { kind: 'watch-rule', watchRuleId: notification.watchRuleId }
      : { kind: 'launch-plan', launchPlanId: installation.launchPlanId },
  });
}

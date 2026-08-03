// Ordered drift WatchDeadline half of one Notification delivery claim.
import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type B3Result,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type ClaimNotificationDeliveryInput, type ClaimedDriftStatus,
  type DurableDriftState, type Notification, type WatchDeadline,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';

type DriftNotification = Extract<Notification, { readonly driftEpisodeId: unknown }>;
type OutstandingDrift = Extract<DurableDriftState, { readonly phase: 'status-outstanding' }>;
type DriftClaim = {
  readonly deadline: WatchDeadline;
  readonly claimedAt: ReturnType<typeof nowIsoUtc>;
};

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('WatcherConflict', message, details, true);

function matchingDeadline(deadline: WatchDeadline, notification: DriftNotification): boolean {
  const state = deadline.driftState;
  if (state?.phase !== 'status-outstanding') return false;
  return deadline.watchRuleId === notification.watchRuleId
    && state.episodeId === notification.driftEpisodeId
    && state.outstandingStatus.episodeId === notification.driftEpisodeId
    && state.outstandingStatus.notificationId === notification.id
    && state.outstandingStatus.effectKey === notification.deliveryEffectKey;
}

function claimedState(
  state: OutstandingDrift,
  claimedAt: ReturnType<typeof nowIsoUtc>,
  reservationId: ClaimNotificationDeliveryInput['notificationInputReservationId'],
): DurableDriftState {
  const outstanding = state.outstandingStatus;
  if (outstanding.state !== 'queued') return state;
  const claimedStatus: ClaimedDriftStatus = {
    episodeId: outstanding.episodeId,
    effectKey: outstanding.effectKey,
    notificationId: outstanding.notificationId,
    state: 'delivery-claimed',
    requestedAt: outstanding.requestedAt,
    claimedAt,
    notificationInputReservationId: reservationId,
  };
  return { ...state, outstandingStatus: claimedStatus };
}

async function findDeadline(
  store: SupervisionStore,
  notification: DriftNotification,
  input: ClaimNotificationDeliveryInput,
): Promise<B3Result<WatchDeadline & { readonly driftState: OutstandingDrift }>> {
  const listed = await store.list<WatchDeadline>('watchDeadline');
  if (!listed.ok) return b3fail(listed.error);
  const matches = listed.value.filter((deadline) => matchingDeadline(deadline, notification));
  if (matches.length !== 1) {
    return b3fail(conflict(
      'a drift delivery must resolve exactly one outstanding WatchDeadline',
      { notificationId: notification.id, matchingDeadlines: matches.length },
    ));
  }
  const deadline = matches[0]! as WatchDeadline & { readonly driftState: OutstandingDrift };
  if (Number(deadline.activityGeneration) !== Number(input.expectedActivityGeneration)) {
    return b3fail(conflict('the drift delivery generation is stale', {
      notificationId: notification.id,
      expectedActivityGeneration: input.expectedActivityGeneration,
      actualActivityGeneration: deadline.activityGeneration,
    }));
  }
  return b3ok(deadline);
}

function adoptExistingClaim(
  deadline: WatchDeadline & { readonly driftState: OutstandingDrift },
  notification: DriftNotification,
  input: ClaimNotificationDeliveryInput,
): B3Result<DriftClaim | null> {
  const outstanding = deadline.driftState.outstandingStatus;
  if (outstanding.state === 'queued') return b3ok(null);
  const reservation = 'notificationInputReservationId' in outstanding
    ? outstanding.notificationInputReservationId : undefined;
  if (reservation !== input.notificationInputReservationId) {
    return b3fail(conflict('the drift delivery is held by another reservation', {
      notificationId: notification.id,
      heldBy: reservation,
      requestedBy: input.notificationInputReservationId,
    }));
  }
  const claimedAt = outstanding.state === 'delivery-claimed'
    ? outstanding.claimedAt : outstanding.submittedAt;
  return b3ok({ deadline, claimedAt });
}

/** Claim the drift half first, or adopt the same durable claim on replay. */
export async function claimDriftDeadline(
  store: SupervisionStore,
  notification: DriftNotification,
  input: ClaimNotificationDeliveryInput,
): Promise<B3Result<DriftClaim>> {
  const found = await findDeadline(store, notification, input);
  if (!found.ok) return found;
  const existing = adoptExistingClaim(found.value, notification, input);
  if (!existing.ok) return existing;
  if (existing.value !== null) return b3ok(existing.value);
  const claimedAt = nowIsoUtc();
  const written = await store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    found.value.id,
    {
      driftState: claimedState(
        found.value.driftState, claimedAt, input.notificationInputReservationId,
      ),
    },
    found.value.recordVersion,
    deriveClientOpId(
      `b3v4:claim-drift-notification-delivery:${found.value.id}:`
        + input.notificationInputReservationId,
    ),
  );
  return written.ok ? b3ok({ deadline: written.value, claimedAt }) : b3fail(written.error);
}

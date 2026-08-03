// LANE C — Q11's transcript half: the only path into `transcript-observed`.
//
// The whole point of Q11 is a distinction that is easy to collapse and expensive
// to get wrong: a Terminal submission proves the INPUT EFFECT happened; it does
// not prove the provider's transcript contains the turn. The delivery engine
// therefore stops at `offered-to-endpoint` and this file owns everything past it.
//
// Two commands, two opposite failure modes to defend against:
//
//   * The positive one must not promote on a NEIGHBOURING turn. Anything can be
//     in a provider transcript; only the turn we caused counts. So it correlates
//     on the durable facts Supervision genuinely owns — the Run it addressed, the
//     Terminal attempt it recorded, the ProviderTurnId Runtime confirmed — plus a
//     digest of the exact logical input it authorised. If the line does not carry
//     OUR text, it is not our turn, however well the identifiers line up.
//
//   * The negative one must not let waiting become an answer. `delivery-uncertain`
//     is a CLOSURE — provider-certified completion past our turn, or a final
//     missing/corrupt source — never "we gave up". A `timeout` is refused
//     outright: it is the absence of evidence wearing evidence's clothes.
//
// Facts Supervision cannot independently verify (the binding, the line, the
// source position/digest, the provider session) are not waved through: they are
// PINNED into `evidenceRefs` on the first write, so a second call carrying
// different evidence is a conflict rather than a silent overwrite. Exact replay
// stays idempotent because the pin is derived from the evidence itself.
import { createHash } from 'node:crypto';
import {
  b3err, b3fail, b3ok, canonicalRequestHash, deriveClientOpId,
  type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  canTransitionNotificationState,
  type Notification, type NotificationId, type NotificationState,
  type RecordNotificationTranscriptNonObservationInput,
  type RecordNotificationTranscriptObservationInput,
  type TranscriptDeliveryNonObservationEvidence,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';

export interface TranscriptObservationDependencies {
  readonly store: SupervisionStore;
}

type TranscriptContext = SystemCommandContext<'sys_transcript'>;

/** The lawful closure reasons, each pinned to the source state that proves it. */
const CLOSURE_REASONS: Readonly<
  Record<
    TranscriptDeliveryNonObservationEvidence['reason'],
    TranscriptDeliveryNonObservationEvidence['sourceDiscoveryState']
  >
> = {
  'complete-for-turn': 'bound',
  'final-source-missing': 'missing',
  'final-source-corrupt': 'corrupt',
};

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('WatcherConflict', message, details, false);

const unknown = (notificationId: NotificationId) =>
  b3err('ValidationFailed', 'unknown notification', { notificationId }, false);

const invalid = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('ValidationFailed', message, details, false);

/**
 * The digest of the exact logical input a Notification authorised.
 *
 * `sha256:<hex>` over the UTF-8 bytes of the logical input — the same text
 * `getNotificationDeliveryAuthority` publishes as `inputText`. Transcript
 * computes the same digest from the line it found; equality is what makes
 * "this is the turn we caused" a fact instead of a correlation.
 */
export function notificationLogicalInputDigest(logicalInput: string): string {
  return `sha256:${createHash('sha256').update(logicalInput, 'utf8').digest('hex')}`;
}

/** One bounded, durable pin for evidence Supervision cannot re-derive later. */
const evidencePin = (kind: string, evidence: unknown): string =>
  `q11-${kind}:${canonicalRequestHash(evidence)}`;

/** The Run a Notification addressed, when it addressed one at all. */
const runOf = (notification: Notification): string | null =>
  notification.subject.kind === 'agent-run' ? notification.subject.agentRunId : null;

/** Read one Notification and refuse anything whose effect key is not its own. */
async function loadForEffect(
  deps: TranscriptObservationDependencies,
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

/**
 * Move one Notification to a Transcript-owned state, pinning its evidence.
 *
 * The replay check runs BEFORE the version CAS, for the same reason the delivery
 * claim does: a duplicate call replays the ORIGINAL request, stale version and
 * all. Version-first would turn every honest Transcript retry into a conflict,
 * and a conflict is exactly what makes a caller try something louder.
 */
async function pinObservation(
  deps: TranscriptObservationDependencies,
  notification: Notification,
  target: NotificationState,
  pin: string,
  extraRefs: readonly string[],
  expectedRecordVersion: number,
): Promise<B3Result<Notification>> {
  if (notification.evidenceRefs.includes(pin)) return b3ok(notification);

  if (!canTransitionNotificationState(notification.state, target)) {
    return b3fail(conflict('this notification cannot move to that state', {
      notificationId: notification.id, from: notification.state, target,
    }));
  }

  if (Number(notification.recordVersion) !== expectedRecordVersion) {
    return b3fail(b3err(
      'VersionConflict',
      'notification record version moved under this observation',
      {
        notificationId: notification.id,
        expected: expectedRecordVersion,
        actual: Number(notification.recordVersion),
      },
      true,
    ));
  }

  const refs = [...notification.evidenceRefs];
  for (const ref of [pin, ...extraRefs]) if (!refs.includes(ref)) refs.push(ref);

  const written = await deps.store.update<Notification>(
    SUPERVISION_RECORD_WRITER,
    notification.id,
    { state: target, evidenceRefs: refs },
    notification.recordVersion,
    deriveClientOpId(`b3v4:notification-transcript:${target}:${notification.id}:${pin}`),
  );
  if (!written.ok) return b3fail(written.error);
  return b3ok(written.value);
}

/**
 * Promote a Notification on Transcript's durable positive evidence (Q11).
 *
 * Every correlation below is against a fact Supervision itself wrote. The
 * Terminal attempt and ProviderTurnId came from Runtime's recorded outcome; the
 * Run came from the watcher subject; the logical-input digest is computed here,
 * from the text this capability authorised — never taken on trust from the
 * caller. Where the durable attempt has no ProviderTurnId yet (a submission that
 * was never confirmed), the observation is what establishes it: seeing the turn
 * in the provider's own transcript is strictly stronger evidence than Terminal's
 * confirmation would have been.
 */
export async function recordNotificationTranscriptObservation(
  deps: TranscriptObservationDependencies,
  _context: TranscriptContext,
  input: RecordNotificationTranscriptObservationInput,
): Promise<B3Result<Notification>> {
  const loaded = await loadForEffect(deps, input.notificationId, input.expectedEffectKey);
  if (!loaded.ok) return b3fail(loaded.error);
  const notification = loaded.value;
  const attempt = notification.deliveryAttempt;
  const { evidence } = input;

  if (attempt.state === 'queued' || attempt.state === 'delivery-claimed') {
    return b3fail(conflict('no provider input was ever submitted for this notification', {
      notificationId: notification.id, deliveryAttempt: attempt.state,
    }));
  }

  if (attempt.terminalInputAttemptId !== input.terminalInputAttemptId) {
    return b3fail(conflict('this Terminal attempt did not carry this notification', {
      notificationId: notification.id,
      expected: attempt.terminalInputAttemptId,
      observed: input.terminalInputAttemptId,
    }));
  }

  if (
    attempt.providerTurnId !== undefined
    && attempt.providerTurnId !== evidence.providerTurnId
  ) {
    return b3fail(conflict('the observed provider turn is not the turn we caused', {
      notificationId: notification.id,
      expected: attempt.providerTurnId,
      observed: evidence.providerTurnId,
    }));
  }

  const agentRunId = runOf(notification);
  if (agentRunId !== String(evidence.agentRunId)) {
    return b3fail(conflict('the observed line belongs to a different Run', {
      notificationId: notification.id, expected: agentRunId, observed: evidence.agentRunId,
    }));
  }

  const authorised = notificationLogicalInputDigest(notification.summary);
  if (evidence.logicalInputDigest !== authorised) {
    return b3fail(conflict('the observed line does not carry the input we authorised', {
      notificationId: notification.id,
      expected: authorised,
      observed: evidence.logicalInputDigest,
    }));
  }

  return pinObservation(
    deps,
    notification,
    'transcript-observed',
    evidencePin('transcript-observed', evidence),
    [`transcriptLine:${String(evidence.transcriptLineId)}`],
    Number(input.expectedRecordVersion),
  );
}

/**
 * Close a Notification as `delivery-uncertain` on durable non-observation (Q11).
 *
 * Only three things close it, and each has to prove itself. `complete-for-turn`
 * must carry the watermark showing the source was read PAST our turn — without
 * it, "complete" is just a claim. The two final-source forms must agree with the
 * discovery state that produced them. And every form must cite evidence: a
 * closure with no refs is an assertion, and assertions do not move durable state.
 *
 * `timeout` is refused by name. Q11's law is that missing evidence never becomes
 * positive by elapsed time, and the same holds in the other direction — a turn
 * we simply have not seen yet is not a turn that did not happen.
 */
export async function recordNotificationTranscriptNonObservation(
  deps: TranscriptObservationDependencies,
  _context: TranscriptContext,
  input: RecordNotificationTranscriptNonObservationInput,
): Promise<B3Result<Notification>> {
  const { evidence } = input;

  const requiredState = CLOSURE_REASONS[evidence.reason];
  if (requiredState === undefined) {
    return b3fail(invalid('only durable non-observation closes a delivery', {
      notificationId: input.notificationId,
      reason: evidence.reason,
      lawful: Object.keys(CLOSURE_REASONS),
    }));
  }
  if (evidence.sourceDiscoveryState !== requiredState) {
    return b3fail(invalid('the closure reason contradicts the source discovery state', {
      notificationId: input.notificationId,
      reason: evidence.reason,
      expected: requiredState,
      observed: evidence.sourceDiscoveryState,
    }));
  }
  if (
    evidence.reason === 'complete-for-turn'
    && (evidence.completeThroughWatermark ?? '') === ''
  ) {
    return b3fail(invalid('completion must name the watermark it was complete through', {
      notificationId: input.notificationId,
    }));
  }
  if (evidence.evidenceRefs.length === 0) {
    return b3fail(invalid('a closure must cite the evidence that closed it', {
      notificationId: input.notificationId, reason: evidence.reason,
    }));
  }

  const loaded = await loadForEffect(deps, input.notificationId, input.expectedEffectKey);
  if (!loaded.ok) return b3fail(loaded.error);
  const notification = loaded.value;
  const attempt = notification.deliveryAttempt;

  const agentRunId = runOf(notification);
  if (agentRunId !== String(evidence.agentRunId)) {
    return b3fail(conflict('this closure belongs to a different Run', {
      notificationId: notification.id, expected: agentRunId, observed: evidence.agentRunId,
    }));
  }

  if (attempt.state === 'queued' || attempt.state === 'delivery-claimed') {
    return b3fail(conflict('no provider input was ever submitted for this notification', {
      notificationId: notification.id, deliveryAttempt: attempt.state,
    }));
  }

  if (attempt.terminalInputAttemptId !== evidence.terminalInputAttemptId) {
    return b3fail(conflict('this Terminal attempt did not carry this notification', {
      notificationId: notification.id,
      expected: attempt.terminalInputAttemptId,
      observed: evidence.terminalInputAttemptId,
    }));
  }

  if (
    attempt.providerTurnId !== undefined
    && attempt.providerTurnId !== evidence.providerTurnId
  ) {
    return b3fail(conflict('this closure names a turn we did not cause', {
      notificationId: notification.id,
      expected: attempt.providerTurnId,
      observed: evidence.providerTurnId,
    }));
  }

  return pinObservation(
    deps,
    notification,
    'delivery-uncertain',
    evidencePin('delivery-uncertain', evidence),
    evidence.evidenceRefs,
    Number(input.expectedRecordVersion),
  );
}

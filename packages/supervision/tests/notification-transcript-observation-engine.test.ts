// LANE C — Q11's transcript-observation engine, behind the landed contract seam.
//
// One law owns this file: a Notification becomes `transcript-observed` ONLY when
// Transcript holds durable evidence that the provider's own transcript contains
// the exact turn we caused — same Run, same provider session, same ProviderTurnId,
// same Terminal attempt, and a digest of the exact logical input we authorised.
// Nothing else promotes it, and no amount of elapsed time does.
//
// The mirror law is the negative one: `delivery-uncertain` is a CLOSURE, not a
// giving-up. It needs provider-certified completion (a watermark past our turn)
// or a final missing/corrupt source. A timeout is neither, so it closes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  deriveClientOpId,
  type AgentRunId, type ProviderSessionId, type ProviderTurnId,
  type SystemCommandContext, type TerminalInputAttemptId,
  type TranscriptBindingId, type TranscriptLineId,
} from '@novakai/foundation/contract';
import {
  createSupervisionStore, notificationLogicalInputDigest,
  recordNotificationTranscriptNonObservation,
  recordNotificationTranscriptObservation,
  type SupervisionStore,
} from '../core/index.js';
import {
  notificationDeliveryEffectKey,
  type Notification, type NotificationId, type NotificationInputReservationId,
  type RecordNotificationTranscriptNonObservationInput,
  type RecordNotificationTranscriptObservationInput,
  type TranscriptDeliveryEvidence, type TranscriptDeliveryNonObservationEvidence,
  type WatchRuleId,
} from '../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000d1' as AgentRunId;
const OTHER_RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000d9' as AgentRunId;
const RULE_ID = 'watchRule_019fd000-0000-7000-8000-0000000000d2' as WatchRuleId;
const ATTEMPT_ID = 'terminalInput_019fd000-0000-7000-8000-0000000000d3' as TerminalInputAttemptId;
const OTHER_ATTEMPT_ID =
  'terminalInput_019fd000-0000-7000-8000-0000000000db' as TerminalInputAttemptId;
const TURN_ID = 'providerTurn_019fd000-0000-7000-8000-0000000000d4' as ProviderTurnId;
const OTHER_TURN_ID = 'providerTurn_019fd000-0000-7000-8000-0000000000dc' as ProviderTurnId;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as ProviderSessionId;
const BINDING_ID = `transcriptBinding_${'b'.repeat(52)}` as TranscriptBindingId;
const LINE_ID = `transcriptLine_${'c'.repeat(64)}` as TranscriptLineId;
const RESERVATION = `notificationInput_${'a'.repeat(52)}` as NotificationInputReservationId;

const SUMMARY = 'Output token threshold reached';

const transcript = (): SystemCommandContext<'sys_transcript'> => ({
  principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
  contractVersion: 1,
});

interface Rig {
  readonly store: SupervisionStore;
  readonly cleanup: () => void;
}

function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lane-c-q11-'));
  return {
    store: createSupervisionStore({ root, dataRoot: path.join(root, '.novakai') }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A Notification whose input effect already happened — Terminal submitted it and
 * Runtime recorded the outcome. This is the ONLY shape Transcript may observe.
 */
async function seedOffered(
  store: SupervisionStore,
  overrides: {
    readonly id?: NotificationId;
    readonly state?: Notification['state'];
    readonly attempt?: Notification['deliveryAttempt'];
  } = {},
): Promise<Notification> {
  const id = overrides.id ?? (`notification_${'d'.repeat(52)}` as NotificationId);
  const effectKey = notificationDeliveryEffectKey(id);
  const written = await store.create<Notification>('sys_supervision', {
    kind: 'notification',
    id,
    schemaVersion: 1,
    createdAt: '2026-08-03T00:01:00.000Z' as never,
    permissionLevel: 'private',
    createdBy: 'sys_supervision',
    deliveryEffectKey: effectKey,
    deliveryAttempt: overrides.attempt ?? {
      state: 'submitted-confirmed',
      effectKey,
      submittedAt: '2026-08-03T00:02:00.000Z' as never,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      providerTurnId: TURN_ID,
    },
    watchRuleId: RULE_ID,
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    conditionGeneration: 1,
    summary: SUMMARY,
    evidenceRefs: ['event_lane_c_q11'],
    state: overrides.state ?? 'offered-to-endpoint',
    deliveryMode: 'start-turn',
    phase: 'condition',
  } as never, deriveClientOpId(`lane-c:q11:${id}:${overrides.state ?? 'offered'}`));
  assert.equal(written.ok, true, written.ok ? '' : written.error.message);
  return written.value;
}

const evidenceFor = (
  notification: Notification,
  overrides: Partial<TranscriptDeliveryEvidence> = {},
): TranscriptDeliveryEvidence => ({
  bindingId: BINDING_ID,
  transcriptLineId: LINE_ID,
  agentRunId: RUN_ID,
  providerSessionId: SESSION_ID,
  providerTurnId: TURN_ID,
  sourcePosition: '0000000042',
  sourceDigest: 'sha256:provider-source-line',
  logicalInputDigest: notificationLogicalInputDigest(notification.summary),
  ...overrides,
});

const observationFor = (
  notification: Notification,
  overrides: Partial<RecordNotificationTranscriptObservationInput> = {},
  evidenceOverrides: Partial<TranscriptDeliveryEvidence> = {},
): RecordNotificationTranscriptObservationInput => ({
  notificationId: notification.id,
  expectedRecordVersion: notification.recordVersion,
  expectedEffectKey: notification.deliveryEffectKey,
  terminalInputAttemptId: ATTEMPT_ID,
  evidence: evidenceFor(notification, evidenceOverrides),
  ...overrides,
});

/** Overrides that may also REMOVE a field — `undefined` means "omit it entirely". */
type ClosureOverrides = {
  readonly [Key in keyof TranscriptDeliveryNonObservationEvidence]?:
    | TranscriptDeliveryNonObservationEvidence[Key]
    | undefined;
};

const closureEvidenceFor = (
  overrides: ClosureOverrides = {},
): TranscriptDeliveryNonObservationEvidence => {
  const merged: Record<string, unknown> = {
    bindingId: BINDING_ID,
    agentRunId: RUN_ID,
    providerSessionId: SESSION_ID,
    providerTurnId: TURN_ID,
    terminalInputAttemptId: ATTEMPT_ID,
    reason: 'complete-for-turn',
    sourceDiscoveryState: 'bound',
    completeThroughWatermark: '0000000099',
    evidenceRefs: [String(BINDING_ID), 'provider-source-result:complete-through-provider-turn'],
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged as unknown as TranscriptDeliveryNonObservationEvidence;
};

const closureFor = (
  notification: Notification,
  evidenceOverrides: ClosureOverrides = {},
  overrides: Partial<RecordNotificationTranscriptNonObservationInput> = {},
): RecordNotificationTranscriptNonObservationInput => ({
  notificationId: notification.id,
  expectedRecordVersion: notification.recordVersion,
  expectedEffectKey: notification.deliveryEffectKey,
  evidence: closureEvidenceFor(evidenceOverrides),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Q11 positive — only the exact turn we caused promotes the Notification.
// ---------------------------------------------------------------------------

test('exact transcript evidence is the one thing that reaches transcript-observed', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification),
    );
    assert.equal(result.ok, true, result.ok ? '' : result.error.message);
    assert.equal(result.value.state, 'transcript-observed');
  } finally { cleanup(); }
});

test('a submission that was never observed stays exactly where Terminal left it', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const stored = await store.read<Notification>('notification', notification.id);
    assert.equal(stored.ok && stored.value?.state, 'offered-to-endpoint');
  } finally { cleanup(); }
});

test('evidence naming a different provider turn cannot promote this notification', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(),
      observationFor(notification, {}, { providerTurnId: OTHER_TURN_ID }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('evidence naming a different Terminal attempt cannot promote this notification', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(),
      observationFor(notification, { terminalInputAttemptId: OTHER_ATTEMPT_ID }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('evidence naming a different Run cannot promote this notification', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification, {}, { agentRunId: OTHER_RUN_ID }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('a transcript line carrying different text than we authorised is not our turn', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(),
      observationFor(notification, {}, {
        logicalInputDigest: notificationLogicalInputDigest('some other agent’s prompt'),
      }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('an effect key that does not identify this notification is refused', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(),
      observationFor(notification, { expectedEffectKey: 'b3v4:notification-delivery:wrong' }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('a queued notification cannot be observed — nothing was ever offered', async () => {
  const { store, cleanup } = rig();
  try {
    const effectKey = notificationDeliveryEffectKey(
      `notification_${'e'.repeat(52)}` as NotificationId,
    );
    const notification = await seedOffered(store, {
      id: `notification_${'e'.repeat(52)}` as NotificationId,
      state: 'queued',
      attempt: { state: 'queued', effectKey },
    });
    const result = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('replaying the exact observation is idempotent, at any record version', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const input = observationFor(notification);
    const first = await recordNotificationTranscriptObservation({ store }, transcript(), input);
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    const replay = await recordNotificationTranscriptObservation({ store }, transcript(), input);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    assert.equal(replay.value.state, 'transcript-observed');
    assert.equal(replay.value.recordVersion, first.value.recordVersion);
  } finally { cleanup(); }
});

test('different evidence for an already-observed notification is a conflict, not a replay', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const first = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification),
    );
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    const second = await recordNotificationTranscriptObservation(
      { store }, transcript(),
      observationFor(first.value, {}, { sourceDigest: 'sha256:a-different-line' }),
    );
    assert.equal(second.ok, false);
  } finally { cleanup(); }
});

test('the observation is durable — it survives a fresh read of the store', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification),
    );
    const stored = await store.read<Notification>('notification', notification.id);
    assert.equal(stored.ok && stored.value?.state, 'transcript-observed');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Q11 negative — `delivery-uncertain` is a closure, and time is not evidence.
// ---------------------------------------------------------------------------

test('provider-certified completion past our turn closes the notification as uncertain', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification),
    );
    assert.equal(result.ok, true, result.ok ? '' : result.error.message);
    assert.equal(result.value.state, 'delivery-uncertain');
  } finally { cleanup(); }
});

test('a final missing source closes it; so does a final corrupt one', async () => {
  const { store, cleanup } = rig();
  try {
    const missing = await seedOffered(store, {
      id: `notification_${'f'.repeat(52)}` as NotificationId,
    });
    const missingResult = await recordNotificationTranscriptNonObservation(
      { store }, transcript(),
      closureFor(missing, {
        reason: 'final-source-missing',
        sourceDiscoveryState: 'missing',
        completeThroughWatermark: undefined,
        evidenceRefs: ['provider-source-result:final-missing'],
      }),
    );
    assert.equal(missingResult.ok, true, missingResult.ok ? '' : missingResult.error.message);
    assert.equal(missingResult.value.state, 'delivery-uncertain');

    const corrupt = await seedOffered(store, {
      id: `notification_${'a'.repeat(52)}` as NotificationId,
    });
    const corruptResult = await recordNotificationTranscriptNonObservation(
      { store }, transcript(),
      closureFor(corrupt, {
        reason: 'final-source-corrupt',
        sourceDiscoveryState: 'corrupt',
        completeThroughWatermark: undefined,
        evidenceRefs: ['provider-source-result:final-corrupt'],
      }),
    );
    assert.equal(corruptResult.ok, true, corruptResult.ok ? '' : corruptResult.error.message);
    assert.equal(corruptResult.value.state, 'delivery-uncertain');
  } finally { cleanup(); }
});

test('completion without a watermark proves nothing was read past our turn', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptNonObservation(
      { store }, transcript(),
      closureFor(notification, { completeThroughWatermark: undefined }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('a reason that contradicts the source discovery state is refused', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification, { sourceDiscoveryState: 'missing' }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('a closure carrying no evidence refs is an assertion, not evidence', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification, { evidenceRefs: [] }),
    );
    assert.equal(result.ok, false);
  } finally { cleanup(); }
});

test('a timeout closes nothing — missing evidence never becomes evidence by waiting', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const result = await recordNotificationTranscriptNonObservation(
      { store }, transcript(),
      closureFor(notification, {
        reason: 'timeout' as never,
        completeThroughWatermark: undefined,
        evidenceRefs: [],
      }),
    );
    assert.equal(result.ok, false);
    const stored = await store.read<Notification>('notification', notification.id);
    assert.equal(stored.ok && stored.value?.state, 'offered-to-endpoint');
  } finally { cleanup(); }
});

test('closure naming a different Run or turn is refused', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const wrongRun = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification, { agentRunId: OTHER_RUN_ID }),
    );
    assert.equal(wrongRun.ok, false);
    const wrongTurn = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification, { providerTurnId: OTHER_TURN_ID }),
    );
    assert.equal(wrongTurn.ok, false);
    const wrongAttempt = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification, {
        terminalInputAttemptId: OTHER_ATTEMPT_ID,
      }),
    );
    assert.equal(wrongAttempt.ok, false);
  } finally { cleanup(); }
});

test('an observed notification can never be walked back to uncertain', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const observed = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(notification),
    );
    assert.equal(observed.ok, true, observed.ok ? '' : observed.error.message);
    const closure = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(observed.value),
    );
    assert.equal(closure.ok, false);
  } finally { cleanup(); }
});

test('replaying the exact closure is idempotent', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const input = closureFor(notification);
    const first = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), input,
    );
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    const replay = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), input,
    );
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    assert.equal(replay.value.state, 'delivery-uncertain');
    assert.equal(replay.value.recordVersion, first.value.recordVersion);
  } finally { cleanup(); }
});

test('an uncertain notification is still promotable by later positive evidence', async () => {
  const { store, cleanup } = rig();
  try {
    const notification = await seedOffered(store);
    const closed = await recordNotificationTranscriptNonObservation(
      { store }, transcript(), closureFor(notification),
    );
    assert.equal(closed.ok, true, closed.ok ? '' : closed.error.message);
    const observed = await recordNotificationTranscriptObservation(
      { store }, transcript(), observationFor(closed.value),
    );
    assert.equal(observed.ok, true, observed.ok ? '' : observed.error.message);
    assert.equal(observed.value.state, 'transcript-observed');
  } finally { cleanup(); }
});

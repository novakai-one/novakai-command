// LANE C — the Notification delivery engine, at the frozen capability boundary.
//
// The seam that owns this slice's risk: watchers EMIT through the frozen
// contract and this consumes it. Every law below is one the cross-lane exam
// hammers on trunk — exactly-once under replay, duplicate delivery, and
// restart mid-delivery — plus the §13.8 delivery-mode laws and the Q11
// principle that a submission is evidence of an INPUT EFFECT and never
// evidence that the provider transcript contains the turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type AgentRunId, type AuthenticatedPrincipal, type B3PrincipalId, type B3Result,
  type ClientOpId, type CommandContext, type ProviderTurnId, type RecordEnvelope,
  type RecordVersion, type SystemCommandContext,
  type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import {
  composeSupervision, createSupervisionStore, type SupervisionStore,
  acknowledgeNotification, claimNotificationDelivery,
  getNotificationDeliveryAuthority, notificationEventPage,
  recordNotificationDeliveryOutcome,
} from '../core/index.js';
import { recordDriftStatusSubmission } from '../core/watchers/submission.js';
import {
  notificationDeliveryEffectKey, parseNotificationEvent, parseNotificationRecord,
  DRIFT_FREE_EVIDENCE, DRIFT_STATUS_PROMPT,
  type DriftEpisodeId, type Notification, type NotificationId,
  type NotificationInputReservationId, type WatchDeadline, type WatchDeadlineId,
  type WatchRule, type WatchRuleId,
} from '../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000c1' as AgentRunId;
const RULE_ID = 'watchRule_019fd000-0000-7000-8000-0000000000c2' as WatchRuleId;
const TRACE_ID = 'trace_123e4567-e89b-42d3-a456-426614174000' as never;
const CLIENT_OP_ID = 'op_123e4567-e89b-42d3-a456-426614174000' as never;
const ATTEMPT_ID = 'terminalInput_019fd000-0000-7000-8000-0000000000c3' as TerminalInputAttemptId;
const TURN_ID = 'providerTurn_019fd000-0000-7000-8000-0000000000c4' as ProviderTurnId;

const reservation = (body: string): NotificationInputReservationId =>
  `notificationInput_${body.repeat(52)}` as NotificationInputReservationId;

const RESERVATION = reservation('a');
const OTHER_RESERVATION = reservation('b');

const runtime = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: CLIENT_OP_ID,
  traceId: TRACE_ID,
  contractVersion: 1,
});

const human: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

const humanContext = (): CommandContext => ({
  principal: human,
  clientOpId: CLIENT_OP_ID,
  traceId: TRACE_ID,
  contractVersion: 1,
});

interface Rig {
  readonly store: SupervisionStore;
  readonly cleanup: () => void;
}

function rig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lane-c-'));
  return {
    store: createSupervisionStore({ root, dataRoot: path.join(root, '.novakai') }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function failNextUpdateFor(store: SupervisionStore, objectId: string): SupervisionStore {
  let shouldFail = true;
  return {
    ...store,
    async update<Record_ extends RecordEnvelope<string, string, number>>(
      principal: B3PrincipalId,
      candidateId: string,
      patch: Record<string, unknown>,
      expectedVersion: RecordVersion,
      clientOpId: ClientOpId,
    ): Promise<B3Result<Record_>> {
      if (shouldFail && candidateId === objectId) {
        shouldFail = false;
        return b3fail(b3err(
          'StoreUnavailable', 'injected crash between the deadline and Notification CAS', {}, true,
        ));
      }
      return store.update<Record_>(
        principal, candidateId, patch, expectedVersion, clientOpId,
      );
    },
  };
}

/** The WatchRule a Notification's delivery authority is resolved FROM. */
async function seedRule(
  store: SupervisionStore,
  deliveryMode: WatchRule['deliveryMode'],
): Promise<WatchRule> {
  const written = await store.create<WatchRule>('sys_supervision', {
    kind: 'watchRule',
    id: RULE_ID,
    schemaVersion: 1,
    createdAt: '2026-08-03T00:00:00.000Z' as never,
    permissionLevel: 'team',
    createdBy: 'sys_supervision',
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    condition: { kind: 'output-tokens-at-least', value: 100_000 },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    deliveryMode,
    cooldownMs: 0,
    status: 'active',
  } as never, deriveClientOpId(`lane-c:rule:${deliveryMode}`));
  assert.equal(written.ok, true, written.ok ? '' : written.error.message);
  return written.value;
}

/** A queued Notification exactly as Lane B's watcher half commits it. */
async function seedQueued(
  store: SupervisionStore,
  deliveryMode: Notification['deliveryMode'],
  state: Notification['state'] = 'queued',
): Promise<Notification> {
  const id = `notification_${'c'.repeat(52)}` as NotificationId;
  const effectKey = notificationDeliveryEffectKey(id);
  const written = await store.create<Notification>('sys_supervision', {
    kind: 'notification',
    id,
    schemaVersion: 1,
    createdAt: '2026-08-03T00:01:00.000Z' as never,
    permissionLevel: 'private',
    createdBy: 'sys_supervision',
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: RULE_ID,
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    conditionGeneration: 1,
    summary: 'Output token threshold reached',
    evidenceRefs: ['event_lane_c_1'],
    state,
    deliveryMode,
    phase: 'condition',
  } as never, deriveClientOpId(`lane-c:notification:${deliveryMode}:${state}`));
  assert.equal(written.ok, true, written.ok ? '' : written.error.message);
  return written.value;
}

/** Several distinct queued notifications, for paging. */
async function seedNotificationWithId(
  store: SupervisionStore,
  id: NotificationId,
): Promise<void> {
  const effectKey = notificationDeliveryEffectKey(id);
  const written = await store.create<Notification>('sys_supervision', {
    kind: 'notification',
    id,
    schemaVersion: 1,
    createdAt: '2026-08-03T00:01:00.000Z' as never,
    permissionLevel: 'private',
    createdBy: 'sys_supervision',
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: RULE_ID,
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    conditionGeneration: 1,
    summary: 'Output token threshold reached',
    evidenceRefs: ['event_lane_c_1'],
    state: 'queued',
    deliveryMode: 'queue-only',
    phase: 'condition',
  } as never, deriveClientOpId(`lane-c:page:${id}`));
  assert.equal(written.ok, true, written.ok ? '' : written.error.message);
}

const claimInput = (
  notification: Notification,
  reservationId: NotificationInputReservationId = RESERVATION,
  version: RecordVersion = notification.recordVersion,
) => ({
  notificationId: notification.id,
  expectedNotificationRecordVersion: version,
  expectedEffectKey: notification.deliveryEffectKey,
  notificationInputReservationId: reservationId,
  expectedActivityGeneration: 1 as never,
});

interface SeededDriftDelivery {
  readonly deadline: WatchDeadline;
  readonly notification: Notification;
}

async function seedQueuedDriftDelivery(store: SupervisionStore): Promise<SeededDriftDelivery> {
  const episodeId = `driftEpisode_${'d'.repeat(52)}` as DriftEpisodeId;
  const deadlineId = `watchDeadline_${'e'.repeat(52)}` as WatchDeadlineId;
  const notificationId = `notification_${'f'.repeat(52)}` as NotificationId;
  const effectKey = notificationDeliveryEffectKey(notificationId, episodeId);
  const rule = await store.create<WatchRule>('sys_supervision', {
    kind: 'watchRule', id: RULE_ID, schemaVersion: 1,
    createdAt: '2026-08-03T00:00:00.000Z', permissionLevel: 'private',
    createdBy: 'sys_supervision',
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    condition: {
      kind: 'activity-drift', intervalMs: 300_000,
      staleAfterIntervals: 2, escalateAfterConsecutive: 3,
    },
    recipient: { kind: 'human', principalId: 'person_chris' },
    deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
    driftPolicy: {
      mode: 'cheap-first', freeEvidence: DRIFT_FREE_EVIDENCE,
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      statusRecipient: 'subject-agent', statusDeliveryMode: 'start-turn',
      replyWindowMs: 300_000, statusPrompt: DRIFT_STATUS_PROMPT,
    },
  } as never, deriveClientOpId('c7:drift-rule'));
  assert.equal(rule.ok, true, rule.ok ? '' : rule.error.message);

  const deadline = await store.create<WatchDeadline>('sys_supervision', {
    kind: 'watchDeadline', id: deadlineId, schemaVersion: 1,
    createdAt: '2026-08-03T00:01:00.000Z', permissionLevel: 'private',
    createdBy: 'sys_supervision', watchRuleId: RULE_ID,
    subjectKey: `agent-run:${RUN_ID}`, activityGeneration: 1,
    dueAt: '2026-08-03T00:06:00.000Z', state: 'claimed',
    driftState: {
      kind: 'activity-drift', phase: 'status-outstanding', episodeOrdinal: 1,
      quietIntervals: 2, episodeId, consecutiveUnansweredChecks: 0,
      outstandingStatus: {
        episodeId, effectKey, notificationId, state: 'queued',
        requestedAt: '2026-08-03T00:01:00.000Z',
      },
    },
  } as never, deriveClientOpId('c7:drift-deadline'));
  assert.equal(deadline.ok, true, deadline.ok ? '' : deadline.error.message);

  const notification = await store.create<Notification>('sys_supervision', {
    kind: 'notification', id: notificationId, schemaVersion: 1,
    createdAt: '2026-08-03T00:01:00.000Z', permissionLevel: 'private',
    createdBy: 'sys_supervision', deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey }, watchRuleId: RULE_ID,
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    recipient: { kind: 'agent', agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' },
    conditionGeneration: 1, summary: DRIFT_STATUS_PROMPT,
    evidenceRefs: ['drift:c7'], state: 'queued', deliveryMode: 'start-turn',
    phase: 'drift-status-request', driftEpisodeId: episodeId,
  } as never, deriveClientOpId('c7:drift-notification'));
  assert.equal(notification.ok, true, notification.ok ? '' : notification.error.message);
  return { deadline: deadline.value, notification: notification.value };
}

// ---------------------------------------------------------------------------
// §13.8 — the delivery modes are not decorations; they gate the effect.
// ---------------------------------------------------------------------------

test('queue-only never starts a turn — it has no provider delivery effect to claim', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'queue-only');
    const queued = await seedQueued(store, 'queue-only');

    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));

    assert.equal(claimed.ok, false);
    assert.equal(claimed.ok ? '' : claimed.error.code, 'NotificationDeliveryUnsafe');

    // And the refusal is not a silent write: the record is untouched.
    const after = await store.read<Notification>('notification', queued.id);
    assert.equal(after.ok && after.value?.state, 'queued');
    assert.equal(after.ok && after.value?.deliveryAttempt.state, 'queued');
  } finally { cleanup(); }
});

test('a start-turn claim offers the notification to the endpoint under one reservation', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');

    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));

    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.error.message);
    if (!claimed.ok) return;
    assert.equal(claimed.value.notification.state, 'offered-to-endpoint');
    assert.equal(claimed.value.notification.deliveryAttempt.state, 'delivery-claimed');
    assert.equal(
      claimed.value.notification.deliveryAttempt.state === 'delivery-claimed'
        && claimed.value.notification.deliveryAttempt.notificationInputReservationId,
      RESERVATION,
    );
    // The record it wrote is one its own frozen parser accepts.
    const parsed = parseNotificationRecord(claimed.value.notification);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  } finally { cleanup(); }
});

test('next-turn-context IS claimable — it rides a turn it did not start', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'next-turn-context');
    const queued = await seedQueued(store, 'next-turn-context');

    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));

    // Q11: queue-only alone "has no provider delivery attempt". next-turn-context
    // has one — it simply may not CAUSE the turn that carries it.
    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.error.message);
    if (!claimed.ok) return;
    assert.equal(claimed.value.notification.state, 'offered-to-endpoint');
  } finally { cleanup(); }
});

test('a drift delivery claim advances and returns its matching WatchDeadline before the Notification', async () => {
  const { store, cleanup } = rig();
  try {
    const { deadline, notification } = await seedQueuedDriftDelivery(store);

    const claimed = await claimNotificationDelivery(
      { store }, runtime(), claimInput(notification),
    );

    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.error.message);
    if (!claimed.ok) return;
    assert.equal(claimed.value.notification.deliveryAttempt.state, 'delivery-claimed');
    assert.equal(claimed.value.watchDeadline?.id, deadline.id);
    assert.equal(
      claimed.value.watchDeadline?.driftState?.phase === 'status-outstanding'
        ? claimed.value.watchDeadline.driftState.outstandingStatus.state : undefined,
      'delivery-claimed',
    );
  } finally { cleanup(); }
});

test('a drift claim replay heals a crash between the deadline and Notification CAS', async () => {
  const { store, cleanup } = rig();
  try {
    const { deadline, notification } = await seedQueuedDriftDelivery(store);
    const crashStore = failNextUpdateFor(store, notification.id);
    const input = claimInput(notification);

    const interrupted = await claimNotificationDelivery({ store: crashStore }, runtime(), input);
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.ok ? '' : interrupted.error.code, 'StoreUnavailable');

    const splitDeadline = await store.read<WatchDeadline>('watchDeadline', deadline.id);
    const splitNotification = await store.read<Notification>('notification', notification.id);
    assert.equal(splitDeadline.ok, true, splitDeadline.ok ? '' : splitDeadline.error.message);
    assert.equal(splitNotification.ok, true, splitNotification.ok ? '' : splitNotification.error.message);
    if (!splitDeadline.ok || !splitDeadline.value || !splitNotification.ok || !splitNotification.value) {
      return;
    }
    assert.equal(splitNotification.value.deliveryAttempt.state, 'queued');
    assert.equal(
      splitDeadline.value.driftState?.phase === 'status-outstanding'
        ? splitDeadline.value.driftState.outstandingStatus.state : undefined,
      'delivery-claimed',
    );
    const splitDeadlineVersion = splitDeadline.value.recordVersion;

    const healed = await claimNotificationDelivery({ store: crashStore }, runtime(), input);
    assert.equal(healed.ok, true, healed.ok ? '' : healed.error.message);
    if (!healed.ok) return;
    assert.equal(healed.value.notification.deliveryAttempt.state, 'delivery-claimed');
    assert.equal(healed.value.watchDeadline?.recordVersion, splitDeadlineVersion);
    assert.equal(
      healed.value.watchDeadline?.driftState?.phase === 'status-outstanding'
        && healed.value.watchDeadline.driftState.outstandingStatus.state === 'delivery-claimed'
        ? healed.value.watchDeadline.driftState.outstandingStatus.notificationInputReservationId
        : undefined,
      RESERVATION,
    );
    assert.equal(
      healed.value.notification.deliveryAttempt.state === 'delivery-claimed'
        ? healed.value.notification.deliveryAttempt.claimedAt : undefined,
      healed.value.watchDeadline?.driftState?.phase === 'status-outstanding'
        && healed.value.watchDeadline.driftState.outstandingStatus.state === 'delivery-claimed'
        ? healed.value.watchDeadline.driftState.outstandingStatus.claimedAt : undefined,
      'healing must preserve the first half claim timestamp',
    );
  } finally { cleanup(); }
});

test('a drift outcome replay heals a crash between the Notification and deadline CAS', async () => {
  const { store, cleanup } = rig();
  try {
    const { deadline, notification } = await seedQueuedDriftDelivery(store);
    const claimed = await claimNotificationDelivery(
      { store }, runtime(), claimInput(notification),
    );
    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.error.message);
    if (!claimed.ok || claimed.value.watchDeadline === undefined) return;
    const input = {
      watchDeadlineId: deadline.id,
      expectedRecordVersion: claimed.value.watchDeadline.recordVersion,
      expectedEpisodeId: notification.driftEpisodeId!,
      expectedEffectKey: notification.deliveryEffectKey,
      expectedNotificationId: notification.id,
      expectedNotificationInputReservationId: RESERVATION,
      expectedTerminalInputAttemptId: ATTEMPT_ID,
      submission: {
        state: 'submitted-confirmed' as const,
        submittedAt: '2026-08-03T00:02:00.000Z' as never,
        providerTurnId: TURN_ID,
      },
    };
    const authority = { verify: async () => b3ok(null) };
    const crashStore = failNextUpdateFor(store, deadline.id);

    const interrupted = await recordDriftStatusSubmission(
      { store: crashStore, authority }, runtime(), input,
    );
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.ok ? '' : interrupted.error.code, 'StoreUnavailable');
    const splitNotification = await store.read<Notification>('notification', notification.id);
    assert.equal(splitNotification.ok, true, splitNotification.ok ? '' : splitNotification.error.message);
    assert.equal(splitNotification.ok && splitNotification.value?.deliveryAttempt.state,
      'submitted-confirmed');

    const healed = await recordDriftStatusSubmission(
      { store: crashStore, authority }, runtime(), input,
    );
    assert.equal(healed.ok, true, healed.ok ? '' : healed.error.message);
    if (!healed.ok) return;
    assert.equal(healed.value.state, 'armed');
    assert.equal(
      healed.value.driftState?.phase === 'status-outstanding'
        ? healed.value.driftState.outstandingStatus.state : undefined,
      'submitted-confirmed',
    );
    assert.equal(healed.value.dueAt, '2026-08-03T00:07:00.000Z');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Exactly-once under replay / duplicate delivery / restart mid-delivery.
// ---------------------------------------------------------------------------

test('replaying the identical claim is idempotent — one reservation, not two', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');

    const first = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    if (!first.ok) return;

    // A duplicate delivery attempt replays the ORIGINAL input, stale version and all.
    const replay = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));

    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (!replay.ok) return;
    assert.deepEqual(replay.value.notification.deliveryAttempt, first.value.notification.deliveryAttempt);
    assert.equal(
      replay.value.notification.recordVersion,
      first.value.notification.recordVersion,
      'a replayed claim must not burn a new record version',
    );
  } finally { cleanup(); }
});

test('a second reservation for an already-claimed notification is refused, never a second turn', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const first = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(first.ok, true);
    if (!first.ok) return;

    const rival = await claimNotificationDelivery(
      { store }, runtime(), claimInput(first.value.notification, OTHER_RESERVATION),
    );

    assert.equal(rival.ok, false);
    assert.equal(rival.ok ? '' : rival.error.code, 'IdempotencyConflict');
  } finally { cleanup(); }
});

test('a claim whose effect key does not match the record is refused', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');

    const wrong = await claimNotificationDelivery({ store }, runtime(), {
      ...claimInput(queued),
      expectedEffectKey: 'b3v4:notification-delivery:someone-elses-effect:condition',
    });

    assert.equal(wrong.ok, false);
    assert.equal(wrong.ok ? '' : wrong.error.code, 'IdempotencyConflict');
  } finally { cleanup(); }
});

test('a stale expected record version is a VersionConflict, not a lost update', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const first = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(first.ok, true);

    // Same notification, DIFFERENT reservation, stale version: the CAS must bite.
    const stale = await claimNotificationDelivery({ store }, runtime(), {
      ...claimInput(queued, OTHER_RESERVATION),
      expectedNotificationRecordVersion: 99 as RecordVersion,
    });

    assert.equal(stale.ok, false);
    assert.equal(stale.ok ? '' : stale.error.code, 'VersionConflict');
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Q11's load-bearing principle: submission is NOT transcript evidence.
// ---------------------------------------------------------------------------

test('a CONFIRMED submission records the attempt and still never claims transcript-observed', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const recorded = await recordNotificationDeliveryOutcome({ store }, runtime(), {
      notificationId: queued.id,
      expectedRecordVersion: claimed.value.notification.recordVersion,
      expectedEffectKey: queued.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      outcome: {
        state: 'submitted-confirmed',
        submittedAt: '2026-08-03T00:02:00.000Z' as never,
        providerTurnId: TURN_ID,
      },
    });

    assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);
    if (!recorded.ok) return;
    assert.equal(recorded.value.deliveryAttempt.state, 'submitted-confirmed');
    assert.equal(
      recorded.value.state,
      'offered-to-endpoint',
      'Terminal confirming the input effect is not evidence the transcript holds the turn',
    );
  } finally { cleanup(); }
});

test('an UNCONFIRMED submission never becomes positive, and never becomes uncertain by itself', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const recorded = await recordNotificationDeliveryOutcome({ store }, runtime(), {
      notificationId: queued.id,
      expectedRecordVersion: claimed.value.notification.recordVersion,
      expectedEffectKey: queued.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      outcome: {
        state: 'submitted-unconfirmed',
        submittedAt: '2026-08-03T00:02:00.000Z' as never,
      },
    });

    assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);
    if (!recorded.ok) return;
    assert.equal(recorded.value.deliveryAttempt.state, 'submitted-unconfirmed');
    assert.notEqual(recorded.value.state, 'transcript-observed');
    assert.equal(
      recorded.value.state,
      'offered-to-endpoint',
      'only Transcript non-observation evidence may move an offered notification to uncertain',
    );
  } finally { cleanup(); }
});

test('an outcome for a reservation that never claimed this notification is refused', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const foreign = await recordNotificationDeliveryOutcome({ store }, runtime(), {
      notificationId: queued.id,
      expectedRecordVersion: claimed.value.notification.recordVersion,
      expectedEffectKey: queued.deliveryEffectKey,
      notificationInputReservationId: OTHER_RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      outcome: {
        state: 'submitted-confirmed',
        submittedAt: '2026-08-03T00:02:00.000Z' as never,
        providerTurnId: TURN_ID,
      },
    });

    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok ? '' : foreign.error.code, 'IdempotencyConflict');
  } finally { cleanup(); }
});

test('recording the same outcome twice is idempotent — a restart mid-delivery costs nothing', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');
    const claimed = await claimNotificationDelivery({ store }, runtime(), claimInput(queued));
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    const outcome = {
      notificationId: queued.id,
      expectedRecordVersion: claimed.value.notification.recordVersion,
      expectedEffectKey: queued.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      outcome: {
        state: 'submitted-confirmed' as const,
        submittedAt: '2026-08-03T00:02:00.000Z' as never,
        providerTurnId: TURN_ID,
      },
    };

    const first = await recordNotificationDeliveryOutcome({ store }, runtime(), outcome);
    const replay = await recordNotificationDeliveryOutcome({ store }, runtime(), outcome);

    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (!first.ok || !replay.ok) return;
    assert.deepEqual(replay.value.deliveryAttempt, first.value.deliveryAttempt);
    assert.equal(replay.value.recordVersion, first.value.recordVersion);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Acknowledgement — the frozen machine, and nothing looser.
// ---------------------------------------------------------------------------

test('acknowledging a merely queued notification is refused by the frozen machine', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'queue-only');
    const queued = await seedQueued(store, 'queue-only');

    const acked = await acknowledgeNotification({ store }, humanContext(), queued.id);

    assert.equal(acked.ok, false);
    assert.equal(acked.ok ? '' : acked.error.code, 'ValidationFailed');
  } finally { cleanup(); }
});

test('acknowledging an observed notification settles it, and replay is idempotent', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const observed = await seedQueued(store, 'start-turn', 'transcript-observed');

    const first = await acknowledgeNotification({ store }, humanContext(), observed.id);
    const replay = await acknowledgeNotification({ store }, humanContext(), observed.id);

    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (!first.ok || !replay.ok) return;
    assert.equal(first.value.state, 'acknowledged');
    assert.equal(replay.value.state, 'acknowledged');
    assert.equal(replay.value.recordVersion, first.value.recordVersion);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// Delivery authority — published only where a turn may lawfully be started.
// ---------------------------------------------------------------------------

test('delivery authority is published for start-turn, carrying the rule that authorised it', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');

    const authority = await getNotificationDeliveryAuthority({ store }, human, queued.id);

    assert.equal(authority.ok, true, authority.ok ? '' : authority.error.message);
    if (!authority.ok) return;
    assert.equal(authority.value.deliveryMode, 'start-turn');
    assert.equal(authority.value.notificationId, queued.id);
    assert.equal(authority.value.deliveryEffectKey, queued.deliveryEffectKey);
    assert.equal(authority.value.agentRunId, RUN_ID);
    assert.deepEqual(authority.value.authoritySource, { kind: 'watch-rule', watchRuleId: RULE_ID });
    assert.equal(authority.value.inputText, queued.summary);
  } finally { cleanup(); }
});

test('no delivery authority exists for queue-only or next-turn-context', async () => {
  for (const deliveryMode of ['queue-only', 'next-turn-context'] as const) {
    const { store, cleanup } = rig();
    try {
      await seedRule(store, deliveryMode);
      const queued = await seedQueued(store, deliveryMode);

      const authority = await getNotificationDeliveryAuthority({ store }, human, queued.id);

      assert.equal(authority.ok, false, `${deliveryMode} must publish no start-turn authority`);
      assert.equal(authority.ok ? '' : authority.error.code, 'NotificationDeliveryUnsafe');
    } finally { cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Connect-first: the same behaviour, reached through the live composition seam.
// ---------------------------------------------------------------------------

test('the composed capability carries current from a queued Notification to a settled one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-lane-c-wire-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      store,
      installAuthority: {
        resolve: async () => b3fail(
          b3err('UnsupportedOperation', 'not exercised by this test', {}, false),
        ),
      },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    });
    await seedRule(store, 'start-turn');
    const queued = await seedQueued(store, 'start-turn');

    // Runtime asks whether it may speak, and for what text.
    const authority = await supervision.getNotificationDeliveryAuthority(human, queued.id);
    assert.equal(authority.ok, true, authority.ok ? '' : authority.error.message);
    if (!authority.ok) return;

    // It binds its reservation at a safe boundary...
    const claimed = await supervision.claimNotificationDelivery(runtime(), {
      notificationId: queued.id,
      expectedNotificationRecordVersion: queued.recordVersion,
      expectedEffectKey: authority.value.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      expectedActivityGeneration: authority.value.activityGeneration,
    });
    assert.equal(claimed.ok, true, claimed.ok ? '' : claimed.error.message);
    if (!claimed.ok) return;

    // ...reports what Terminal saw...
    const recorded = await supervision.recordNotificationDeliveryOutcome(runtime(), {
      notificationId: queued.id,
      expectedRecordVersion: claimed.value.notification.recordVersion,
      expectedEffectKey: authority.value.deliveryEffectKey,
      notificationInputReservationId: RESERVATION,
      terminalInputAttemptId: ATTEMPT_ID,
      outcome: {
        state: 'submitted-confirmed',
        submittedAt: '2026-08-03T00:03:00.000Z' as never,
        providerTurnId: TURN_ID,
      },
    });
    assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);
    if (!recorded.ok) return;

    // ...and the reader sees an offered notification, NOT an observed one.
    const listed = await supervision.listNotifications(human, { limit: 10 });
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error.message);
    if (!listed.ok) return;
    assert.equal(listed.value.items.length, 1);
    assert.equal(listed.value.items[0]?.state, 'offered-to-endpoint');

    // A person cannot settle it while nothing has observed the delivery.
    const premature = await supervision.acknowledgeNotification(humanContext(), queued.id);
    assert.equal(premature.ok, false, 'ack must not outrun delivery evidence on the live wire');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Q8's bounded, cursor-resumable notification stream.
// ---------------------------------------------------------------------------

test('the notification event page is bounded, ordered and resumable from its cursor', async () => {
  const { store, cleanup } = rig();
  try {
    await seedRule(store, 'queue-only');
    for (const suffix of ['d', 'e', 'f']) {
      await seedNotificationWithId(store, `notification_${suffix.repeat(52)}` as NotificationId);
    }

    const first = await notificationEventPage({ store }, { limit: 2 });
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    if (!first.ok) return;
    assert.equal(first.value.items.length, 2, 'limit must bound the page, not be advisory');
    for (const event of first.value.items) {
      assert.equal(event.kind, 'supervision.notification.changed');
      assert.equal(event.sourceOwner, 'supervision');
      const parsed = parseNotificationEvent(event);
      assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
    }

    assert.notEqual(first.value.nextCursor, undefined, 'a bounded page must say how to resume');
    const rest = await notificationEventPage(
      { store }, { limit: 2, after: first.value.nextCursor as never },
    );
    assert.equal(rest.ok, true, rest.ok ? '' : rest.error.message);
    if (!rest.ok) return;
    assert.equal(rest.value.items.length, 1, 'resuming must not repeat what the first page carried');
    const seen = [...first.value.items, ...rest.value.items].map((event) => event.payload.id);
    assert.equal(new Set(seen).size, 3, 'no notification may appear on two pages');
  } finally { cleanup(); }
});

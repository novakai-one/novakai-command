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
  deriveClientOpId,
  type AgentRunId, type AuthenticatedPrincipal, type CommandContext,
  type ProviderTurnId, type RecordVersion, type SystemCommandContext,
  type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import {
  createSupervisionStore, type SupervisionStore,
  acknowledgeNotification, claimNotificationDelivery,
  getNotificationDeliveryAuthority, recordNotificationDeliveryOutcome,
} from '../core/index.js';
import {
  notificationDeliveryEffectKey, parseNotificationRecord,
  type Notification, type NotificationId,
  type NotificationInputReservationId, type WatchRule, type WatchRuleId,
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

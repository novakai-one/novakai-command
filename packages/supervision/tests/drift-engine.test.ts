import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3ok,
  deriveClientOpId,
  type AgentRunId,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  composeSupervision,
  createSupervisionStore,
  type SupervisionCore,
  type SupervisionCoreOptions,
} from '../core/index.js';
import {
  deriveDriftEpisodeId,
  deriveNotificationId,
  deriveNotificationInputReservationId,
  DRIFT_STATUS_PROMPT,
  ACTIVITY_DRIFT_TEMPLATE,
  notificationDeliveryEffectKey,
  type CheckRunDriftInput,
  type DriftCheckOutcome,
  type Notification,
  type SupervisionContract,
  type WatchDeadline,
  watchRemoveRetirement,
} from '../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000b1' as AgentRunId;
const PLAN_ID = 'launchPlan_019fd000-0000-7000-8000-0000000000b2' as never;

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174100' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
  contractVersion: 1,
});

const supervisionContext = (): SystemCommandContext<'sys_supervision'> => ({
  principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174101' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174101' as never,
  contractVersion: 1,
});

const humanContext = () => ({
  principal: { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174102' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174102' as never,
  contractVersion: 1 as const,
});

const scopedHumanContext = () => ({
  ...humanContext(),
  principal: {
    ...humanContext().principal,
    verifiedScopes: ['supervision:watch:start-turn' as never],
  },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174103' as never,
});

function unwrap<Value>(result: { readonly ok: true; readonly value: Value } | {
  readonly ok: false; readonly error: { readonly message: string };
}): Value {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('identical free evidence establishes a baseline then opens one quiet episode without a turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-drift-'));
  let now = new Date('2026-08-03T00:00:00.000Z');
  let sample = 0;
  let transcriptWatermark = 'transcript.42';
  let replyEvidenceRef: string | undefined;
  const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
  const options = {
    root,
    dataRoot: path.join(root, 'stores'),
    store,
    clock: () => now,
    installAuthority: {
      resolve: async () => b3ok({
        agentRunId: RUN_ID,
        launchPlanId: PLAN_ID,
        activityDrift: 'required' as const,
        requiredTemplateRefs: [],
        parentNotificationMode: 'queue-only' as const,
        recipient: { kind: 'human' as const, principalId: 'person_chris' as never },
        activityGeneration: 4 as never,
        watchStartTurnAuthorized: true,
        requestProvenance: {
          requestedBy: 'person_chris' as never,
          traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
        },
      }),
    },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    driftEvidence: {
      observe: async () => b3ok({
        terminalLiveness: 'live' as const,
        terminalActivityGeneration: 4 as never,
        agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
        transcriptWatermark,
        usageActivityDigest: 'usage:in=10;out=20;turns=2',
        usageSourceCursor: 'usage.7',
        evidenceRefs: [`sample-${String(++sample)}`],
        ...(replyEvidenceRef === undefined ? {} : { replyEvidenceRef }),
      }),
    },
    driftSubmissionAuthority: { verify: async () => b3ok(null) },
    watchRuleGeneration: { generationFor: async () => b3ok(9 as never) },
  } as SupervisionCoreOptions & {
    readonly driftEvidence: {
      observe(agentRunId: AgentRunId): Promise<ReturnType<typeof b3ok<{
        readonly terminalLiveness: 'live';
        readonly terminalActivityGeneration: never;
        readonly agentId: never;
        readonly transcriptWatermark: string;
        readonly usageActivityDigest: string;
        readonly usageSourceCursor: string;
        readonly evidenceRefs: readonly string[];
      }>>>;
    };
  };
  const supervision = composeSupervision(options) as SupervisionCore & SupervisionContract;

  try {
    const rules = unwrap(await supervision.installRunWatchers(runtimeContext(), {
      agentRunId: RUN_ID,
      launchPlanId: PLAN_ID,
      requiredTemplateRefs: [],
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      activityGeneration: 4 as never,
      requestProvenance: {
        requestedBy: 'person_chris' as never,
        traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
        clientOpId: runtimeContext().clientOpId,
      },
    }));
    const rule = rules[0]!;
    let deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    const input = (): CheckRunDriftInput => ({
      watchRuleId: rule.id,
      agentRunId: RUN_ID,
      expectedActivityGeneration: 4 as never,
      dueDeadlineId: deadline.id,
      expectedDeadlineRecordVersion: deadline.recordVersion,
    });

    now = new Date('2026-08-03T00:05:00.000Z');
    const claimed = unwrap(await supervision.claimDueDeadlines(supervisionContext(), {
      dueBefore: '2026-08-03T00:05:00.000Z' as IsoUtc,
      limit: 10,
      schedulerLeaseMs: 30_000,
    }));
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.id, deadline.id);
    assert.equal(claimed[0]!.state, 'claimed');
    assert.equal(claimed[0]!.lateByMs, 0);
    deadline = claimed[0]!;
    const baseline: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(baseline, {
      kind: 'healthy-free-evidence',
      providerTurnsStartedThisEvaluation: 0,
      evidenceRefs: ['sample-1'],
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:10:00.000Z');
    assert.equal(deadline.driftState?.quietIntervals, 0);
    const fingerprint = deadline.driftState?.lastEvidence?.fingerprint;
    assert.equal(typeof fingerprint, 'string');

    now = new Date('2026-08-03T00:10:00.000Z');
    const quiet: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(quiet, {
      kind: 'first-quiet-interval',
      providerTurnsStartedThisEvaluation: 0,
      staleIntervals: 1,
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:15:00.000Z');
    assert.equal(deadline.driftState?.lastEvidence?.fingerprint, fingerprint,
      'audit refs and checkedAt changed the activity-bearing fingerprint');
    assert.equal(deadline.driftState?.episodeOrdinal, 1);
    assert.equal(deadline.driftState?.quietIntervals, 1);
    assert.equal(deadline.driftState?.episodeId, deriveDriftEpisodeId({
      watchRuleId: rule.id,
      subjectKey: deadline.subjectKey,
      activityGeneration: deadline.activityGeneration,
      fingerprint: fingerprint!,
      episodeOrdinal: 1,
    }));

    now = new Date('2026-08-03T00:15:00.000Z');
    const queued: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(queued.kind, 'status-turn-queued');
    assert.equal(queued.providerTurnsStartedThisEvaluation, 0);
    if (queued.kind !== 'status-turn-queued') throw new Error('status request was not queued');
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:20:00.000Z');
    assert.equal(deadline.driftState?.phase, 'status-outstanding');
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 0);
    assert.equal(deadline.driftState?.outstandingStatus?.state, 'queued');
    assert.equal('replyDueAt' in deadline.driftState!.outstandingStatus!, false);
    const notifications = unwrap(await store.list<Notification>('notification'));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]!.id, queued.notificationId);
    assert.equal(notifications[0]!.phase, 'drift-status-request');
    assert.deepEqual(notifications[0]!.recipient, {
      kind: 'agent', agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
    });
    assert.equal(notifications[0]!.deliveryMode, 'start-turn');
    assert.equal(notifications[0]!.summary, DRIFT_STATUS_PROMPT);
    assert.equal(notifications[0]!.state, 'queued');
    assert.equal(notifications[0]!.deliveryAttempt.state, 'queued');

    now = new Date('2026-08-03T00:20:00.000Z');
    const stillQueued: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(stillQueued.kind, 'status-turn-queued');
    assert.equal(stillQueued.providerTurnsStartedThisEvaluation, 0);
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 0,
      'a queued status request aged into an unanswered check');
    assert.equal(unwrap(await store.list('notification')).length, 1,
      'the same quiet episode queued another status turn');

    transcriptWatermark = 'transcript.43';
    now = new Date('2026-08-03T00:25:00.000Z');
    const cancelled: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(cancelled.kind, 'status-cancelled-before-delivery');
    assert.equal(cancelled.providerTurnsStartedThisEvaluation, 0);
    if (cancelled.kind !== 'status-cancelled-before-delivery') {
      throw new Error('queued status was not cancelled by movement');
    }
    assert.equal(cancelled.movementEvidenceRef, 'sample-5');
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:30:00.000Z');
    assert.equal(deadline.driftState?.phase, 'observing');
    assert.equal(deadline.driftState?.quietIntervals, 0);
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 0);
    assert.deepEqual(deadline.driftState?.lastClosedStatus, {
      episodeId: cancelled.episodeId,
      effectKey: queued.effectKey,
      notificationId: queued.notificationId,
      state: 'cancelled-before-delivery',
      closedAt: '2026-08-03T00:25:00.000Z',
      closureEvidenceRef: 'sample-5',
    });
    const cancelledNotification = unwrap(
      await store.list<Notification>('notification'),
    )[0]!;
    assert.equal(cancelledNotification.state, 'expired');

    now = new Date('2026-08-03T00:30:00.000Z');
    unwrap(await supervision.checkRunDrift(supervisionContext(), input()));
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    now = new Date('2026-08-03T00:35:00.000Z');
    const secondQueued = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(secondQueued.kind, 'status-turn-queued');
    if (secondQueued.kind !== 'status-turn-queued') throw new Error('second status not queued');
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    const secondNotification = unwrap(
      await store.list<Notification>('notification'),
    ).find((item) => item.id === secondQueued.notificationId)!;
    const reservationId = deriveNotificationInputReservationId(secondQueued.effectKey);
    const terminalInputAttemptId =
      'terminalInput_019fd000-0000-7000-8000-0000000000b3' as never;
    const providerTurnId = 'providerTurn_019fd000-0000-7000-8000-0000000000b4' as never;
    const outstanding = deadline.driftState?.outstandingStatus;
    assert.equal(outstanding?.state, 'queued');
    if (outstanding?.state !== 'queued') throw new Error('expected queued drift status');
    deadline = unwrap(await store.update<WatchDeadline>(
      'sys_supervision',
      deadline.id,
      {
        driftState: {
          ...deadline.driftState,
          outstandingStatus: {
            ...outstanding,
            state: 'delivery-claimed',
            claimedAt: '2026-08-03T00:35:30.000Z',
            notificationInputReservationId: reservationId,
          },
        },
      },
      deadline.recordVersion,
      deriveClientOpId(`test:claim-drift:${deadline.id}`),
    ));
    unwrap(await store.update<Notification>(
      'sys_supervision',
      secondNotification.id,
      {
        state: 'offered-to-endpoint',
        deliveryAttempt: {
          state: 'delivery-claimed',
          effectKey: secondQueued.effectKey,
          claimedAt: '2026-08-03T00:35:30.000Z',
          notificationInputReservationId: reservationId,
        },
      },
      secondNotification.recordVersion,
      deriveClientOpId(`test:claim-notification:${secondNotification.id}`),
    ));

    const submissionInput = {
      watchDeadlineId: deadline.id,
      expectedRecordVersion: deadline.recordVersion,
      expectedEpisodeId: deadline.driftState!.episodeId!,
      expectedEffectKey: secondQueued.effectKey,
      expectedNotificationId: secondQueued.notificationId,
      expectedNotificationInputReservationId: reservationId,
      expectedTerminalInputAttemptId: terminalInputAttemptId,
      submission: {
        state: 'submitted-confirmed' as const,
        submittedAt: '2026-08-03T00:36:00.000Z' as IsoUtc,
        providerTurnId,
      },
    };
    const submitted = unwrap(await supervision.recordDriftStatusSubmission(
      runtimeContext(), submissionInput,
    ));
    assert.equal(submitted.dueAt, '2026-08-03T00:41:00.000Z');
    assert.equal(submitted.driftState?.outstandingStatus?.state, 'submitted-confirmed');
    assert.equal(submitted.driftState?.outstandingStatus?.replyDueAt,
      '2026-08-03T00:41:00.000Z');
    assert.equal(submitted.driftState?.outstandingStatus?.providerTurnId, providerTurnId);
    const submittedNotification = unwrap(
      await store.read<Notification>('notification', secondQueued.notificationId),
    )!;
    assert.equal(submittedNotification.deliveryAttempt.state, 'submitted-confirmed');
    assert.equal(submittedNotification.state, 'offered-to-endpoint');

    const replayed = unwrap(await supervision.recordDriftStatusSubmission(
      runtimeContext(), submissionInput,
    ));
    assert.deepEqual(replayed, submitted, 'submission replay changed durable state');

    deadline = submitted;
    transcriptWatermark = 'transcript.44';
    replyEvidenceRef = 'transcript-turn:reply-44';
    now = new Date('2026-08-03T00:41:00.000Z');
    const replied = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(replied, {
      kind: 'status-replied',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveDrift: 0,
      replyEvidenceRef: 'transcript-turn:reply-44',
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:46:00.000Z');
    assert.equal(deadline.driftState?.phase, 'observing');
    assert.equal(deadline.driftState?.quietIntervals, 0);
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 0);
    assert.deepEqual(deadline.driftState?.lastClosedStatus, {
      episodeId: submissionInput.expectedEpisodeId,
      effectKey: submissionInput.expectedEffectKey,
      notificationId: submissionInput.expectedNotificationId,
      state: 'replied',
      closedAt: '2026-08-03T00:41:00.000Z',
      closureEvidenceRef: 'transcript-turn:reply-44',
    });

    replyEvidenceRef = undefined;
    now = new Date('2026-08-03T00:46:00.000Z');
    unwrap(await supervision.checkRunDrift(supervisionContext(), input()));
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    now = new Date('2026-08-03T00:51:00.000Z');
    const thirdQueued = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(thirdQueued.kind, 'status-turn-queued');
    if (thirdQueued.kind !== 'status-turn-queued') throw new Error('third status not queued');
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    const thirdNotification = unwrap(
      await store.list<Notification>('notification'),
    ).find((item) => item.id === thirdQueued.notificationId)!;
    const thirdReservationId = deriveNotificationInputReservationId(thirdQueued.effectKey);
    const thirdTerminalAttemptId =
      'terminalInput_019fd000-0000-7000-8000-0000000000b5' as never;
    const thirdOutstanding = deadline.driftState?.outstandingStatus;
    assert.equal(thirdOutstanding?.state, 'queued');
    if (thirdOutstanding?.state !== 'queued') throw new Error('third status not queued');
    deadline = unwrap(await store.update<WatchDeadline>(
      'sys_supervision',
      deadline.id,
      {
        driftState: {
          ...deadline.driftState,
          outstandingStatus: {
            ...thirdOutstanding,
            state: 'delivery-claimed',
            claimedAt: '2026-08-03T00:51:30.000Z',
            notificationInputReservationId: thirdReservationId,
          },
        },
      },
      deadline.recordVersion,
      deriveClientOpId('test:claim-third-drift:' + deadline.id),
    ));
    unwrap(await store.update<Notification>(
      'sys_supervision',
      thirdNotification.id,
      {
        state: 'offered-to-endpoint',
        deliveryAttempt: {
          state: 'delivery-claimed',
          effectKey: thirdQueued.effectKey,
          claimedAt: '2026-08-03T00:51:30.000Z',
          notificationInputReservationId: thirdReservationId,
        },
      },
      thirdNotification.recordVersion,
      deriveClientOpId('test:claim-third-notification:' + thirdNotification.id),
    ));
    transcriptWatermark = 'transcript.45';
    now = new Date('2026-08-03T00:56:00.000Z');
    const claimedMovement = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(claimedMovement.kind, 'healthy-free-evidence');
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.driftState?.outstandingStatus?.state, 'delivery-claimed');
    assert.equal(
      deadline.driftState?.outstandingStatus?.state === 'delivery-claimed'
        ? deadline.driftState.outstandingStatus.pendingMovementEvidenceRef
        : undefined,
      'sample-11',
    );
    const uncertainInput = {
      watchDeadlineId: deadline.id,
      expectedRecordVersion: deadline.recordVersion,
      expectedEpisodeId: deadline.driftState!.episodeId!,
      expectedEffectKey: thirdQueued.effectKey,
      expectedNotificationId: thirdQueued.notificationId,
      expectedNotificationInputReservationId: thirdReservationId,
      expectedTerminalInputAttemptId: thirdTerminalAttemptId,
      submission: {
        state: 'submitted-unconfirmed' as const,
        submittedAt: '2026-08-03T00:56:30.000Z' as IsoUtc,
      },
    };
    const closedAfterClaim = unwrap(await supervision.recordDriftStatusSubmission(
      runtimeContext(), uncertainInput,
    ));
    assert.equal(closedAfterClaim.dueAt, '2026-08-03T01:01:30.000Z');
    assert.equal(closedAfterClaim.driftState?.phase, 'observing');
    assert.equal(closedAfterClaim.driftState?.quietIntervals, 0);
    assert.deepEqual(closedAfterClaim.driftState?.lastClosedStatus, {
      episodeId: uncertainInput.expectedEpisodeId,
      effectKey: uncertainInput.expectedEffectKey,
      notificationId: uncertainInput.expectedNotificationId,
      state: 'activity-observed-after-submission',
      closedAt: '2026-08-03T00:56:30.000Z',
      closureEvidenceRef: 'sample-11',
    });
    assert.equal(
      unwrap(await store.read<Notification>(
        'notification', uncertainInput.expectedNotificationId,
      ))!.state,
      'delivery-uncertain',
    );
    assert.deepEqual(
      unwrap(await supervision.recordDriftStatusSubmission(runtimeContext(), uncertainInput)),
      closedAfterClaim,
      'pending-movement submission replay did not reconcile the closed episode',
    );

    deadline = closedAfterClaim;
    const timeoutFingerprint = deadline.driftState!.lastEvidence!.fingerprint;
    const timeoutEpisodeId = deriveDriftEpisodeId({
      watchRuleId: rule.id,
      subjectKey: deadline.subjectKey,
      activityGeneration: deadline.activityGeneration,
      fingerprint: timeoutFingerprint,
      episodeOrdinal: deadline.driftState!.episodeOrdinal + 1,
    });
    const timeoutNotificationId = deriveNotificationId({
      watchRuleId: rule.id,
      subjectKey: deadline.subjectKey,
      condition: rule.condition,
      activityGeneration: deadline.activityGeneration,
      episodeId: timeoutEpisodeId,
      phase: 'drift-status-request',
    });
    const timeoutEffectKey = notificationDeliveryEffectKey(
      timeoutNotificationId, timeoutEpisodeId,
    );
    const timeoutReservationId = deriveNotificationInputReservationId(timeoutEffectKey);
    const timeoutAttemptId =
      'terminalInput_019fd000-0000-7000-8000-0000000000b6' as never;
    const timeoutTurnId = 'providerTurn_019fd000-0000-7000-8000-0000000000b7' as never;
    const timeoutNotification = unwrap(await store.create<Notification>(
      'sys_supervision',
      {
        kind: 'notification',
        id: timeoutNotificationId,
        schemaVersion: 1,
        createdAt: '2026-08-03T01:01:00.000Z' as IsoUtc,
        permissionLevel: 'private',
        createdBy: 'sys_supervision',
        deliveryEffectKey: timeoutEffectKey,
        deliveryAttempt: {
          state: 'submitted-confirmed',
          effectKey: timeoutEffectKey,
          submittedAt: '2026-08-03T01:01:30.000Z' as IsoUtc,
          notificationInputReservationId: timeoutReservationId,
          terminalInputAttemptId: timeoutAttemptId,
          providerTurnId: timeoutTurnId,
        },
        watchRuleId: rule.id,
        subject: rule.subject,
        recipient: {
          kind: 'agent',
          agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
        },
        conditionGeneration: Number(deadline.activityGeneration),
        summary: DRIFT_STATUS_PROMPT,
        evidenceRefs: ['sample-timeout'],
        state: 'offered-to-endpoint',
        deliveryMode: 'start-turn',
        phase: 'drift-status-request',
        driftEpisodeId: timeoutEpisodeId,
      },
      deriveClientOpId('test:timeout-notification:' + timeoutNotificationId),
    ));
    deadline = unwrap(await store.update<WatchDeadline>(
      'sys_supervision',
      deadline.id,
      {
        dueAt: '2026-08-03T01:06:30.000Z',
        driftState: {
          kind: 'activity-drift',
          episodeOrdinal: deadline.driftState!.episodeOrdinal + 1,
          phase: 'status-outstanding',
          quietIntervals: 2,
          episodeId: timeoutEpisodeId,
          consecutiveUnansweredChecks: 0,
          lastEvidence: deadline.driftState!.lastEvidence,
          outstandingStatus: {
            episodeId: timeoutEpisodeId,
            effectKey: timeoutEffectKey,
            notificationId: timeoutNotificationId,
            state: 'submitted-confirmed',
            requestedAt: '2026-08-03T01:01:00.000Z',
            submittedAt: '2026-08-03T01:01:30.000Z',
            replyDueAt: '2026-08-03T01:06:30.000Z',
            providerTurnId: timeoutTurnId,
            notificationInputReservationId: timeoutReservationId,
            terminalInputAttemptId: timeoutAttemptId,
          },
        },
      },
      deadline.recordVersion,
      deriveClientOpId('test:timeout-deadline:' + deadline.id),
    ));
    const notificationCount = unwrap(await store.list<Notification>('notification')).length;

    now = new Date('2026-08-03T01:06:30.000Z');
    const unansweredOne = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(unansweredOne, {
      kind: 'status-still-unanswered',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveUnansweredChecks: 1,
      effectKey: timeoutEffectKey,
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T01:11:30.000Z');
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 1);

    now = new Date('2026-08-03T01:11:30.000Z');
    const unansweredTwo = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(unansweredTwo, {
      kind: 'status-still-unanswered',
      providerTurnsStartedThisEvaluation: 0,
      consecutiveUnansweredChecks: 2,
      effectKey: timeoutEffectKey,
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T01:16:30.000Z');
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 2);
    assert.equal(unwrap(await store.list<Notification>('notification')).length, notificationCount);
    assert.equal(
      unwrap(await store.read<Notification>('notification', timeoutNotificationId))!.recordVersion,
      timeoutNotification.recordVersion,
      'an unanswered window rewrote or duplicated the status request',
    );

    now = new Date('2026-08-03T01:16:30.000Z');
    const escalated = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(escalated.kind, 'human-escalation-queued');
    assert.equal(escalated.providerTurnsStartedThisEvaluation, 0);
    if (escalated.kind !== 'human-escalation-queued') {
      throw new Error('third unanswered window did not escalate');
    }
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.driftState?.phase, 'escalated-waiting-human');
    assert.equal(deadline.driftState?.consecutiveUnansweredChecks, 3);
    assert.equal(deadline.driftState?.escalationNotificationId, escalated.notificationId);
    const escalation = unwrap(
      await store.read<Notification>('notification', escalated.notificationId),
    )!;
    assert.equal(escalation.phase, 'drift-human-escalation');
    assert.notEqual(escalation.id, timeoutNotificationId);
    assert.deepEqual(escalation.recipient, {
      kind: 'human', principalId: 'person_chris',
    });
    assert.equal(escalation.deliveryMode, 'queue-only');
    assert.equal(escalation.state, 'queued');
    const afterEscalationCount = unwrap(
      await store.list<Notification>('notification'),
    ).length;

    now = new Date('2026-08-03T01:21:30.000Z');
    const stillEscalated = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.equal(stillEscalated.kind, 'human-escalation-queued');
    assert.equal(stillEscalated.providerTurnsStartedThisEvaluation, 0);
    assert.equal(
      unwrap(await store.list<Notification>('notification')).length,
      afterEscalationCount,
      'an escalated episode queued a second human alert',
    );
    assert.equal(
      unwrap(await store.read<Notification>('notification', escalated.notificationId))!
        .recordVersion,
      escalation.recordVersion,
      'suppressed escalation replay rewrote the human alert',
    );
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    const wrongReset = await supervision.resetDriftEpisode(humanContext(), {
      watchDeadlineId: deadline.id,
      expectedRecordVersion: deadline.recordVersion,
      expectedEpisodeId: ('driftEpisode_' + 'z'.repeat(52)) as never,
      reason: 'operator confirmed the Run is healthy',
    });
    assert.equal(wrongReset.ok, false);
    if (!wrongReset.ok) assert.equal(wrongReset.error.code, 'WatcherConflict');
    const beforeResetCount = unwrap(await store.list<Notification>('notification')).length;
    const reset = unwrap(await supervision.resetDriftEpisode(humanContext(), {
      watchDeadlineId: deadline.id,
      expectedRecordVersion: deadline.recordVersion,
      expectedEpisodeId: timeoutEpisodeId,
      reason: 'operator confirmed the Run is healthy',
    }));
    assert.equal(reset.dueAt, '2026-08-03T01:26:30.000Z');
    assert.equal(reset.driftState?.phase, 'observing');
    assert.equal(reset.driftState?.quietIntervals, 0);
    assert.equal(reset.driftState?.consecutiveUnansweredChecks, 0);
    assert.equal(reset.driftState?.episodeOrdinal, deadline.driftState?.episodeOrdinal);
    assert.deepEqual(reset.driftState?.lastEvidence, deadline.driftState?.lastEvidence);
    assert.equal(unwrap(await store.list<Notification>('notification')).length, beforeResetCount);

    const manualActivityRule = {
      subject: { kind: 'agent-run' as const, agentRunId: RUN_ID },
      condition: ACTIVITY_DRIFT_TEMPLATE.condition,
      recipient: { kind: 'human' as const, principalId: 'person_chris' as never },
      deliveryMode: 'queue-only' as const,
      cooldownMs: 0,
      status: 'active' as const,
      driftPolicy: ACTIVITY_DRIFT_TEMPLATE.driftPolicy,
    };
    const deniedCreate = await supervision.createWatchRule(
      humanContext(), manualActivityRule,
    );
    assert.equal(deniedCreate.ok, false);
    if (!deniedCreate.ok) assert.equal(deniedCreate.error.code, 'PermissionDenied');
    const created = unwrap(await supervision.createWatchRule(
      scopedHumanContext(), manualActivityRule,
    ));
    assert.equal(created.condition.kind, 'activity-drift');
    const createdDeadline = unwrap(
      await store.list<WatchDeadline>('watchDeadline'),
    ).find((item) => item.watchRuleId === created.id)!;
    assert.equal(createdDeadline.activityGeneration, 9);
    assert.equal(createdDeadline.dueAt, '2026-08-03T01:26:30.000Z');
    assert.equal(createdDeadline.driftState?.phase, 'observing');

    const retired = unwrap(await supervision.updateWatchRule(
      {
        ...humanContext(),
        clientOpId: 'op_123e4567-e89b-42d3-a456-426614174104' as never,
      },
      watchRemoveRetirement(created),
    ));
    assert.equal(retired.status, 'retired');
    assert.equal(
      unwrap(await store.read<WatchDeadline>('watchDeadline', createdDeadline.id))!.state,
      'superseded',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

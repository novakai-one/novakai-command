// Q7's Runtime-owned Notification delivery operation.
//
// Supervision decides that a turn is authorised, Terminal owns the keyboard
// fence and observed submission, and Agent Runtime owns the recoverable order
// between them. The RunOperation is durable before the first input effect.
import { createHash } from 'node:crypto';
import {
  b3err, b3fail, b3ok, deriveClientOpId, mintProviderTurnId,
  notificationInputReservationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type NotificationInputReservationId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/runs-api.js';
import type { NotificationInputAttemptFacts } from '../contract/ports.js';
import type { RunOperation, RunOperationStage } from '../contract/runs.js';
import { advance, openOperation, settleOperation } from './journal.js';
import { requireRun, type RunsCore } from './runs-context.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const unsafe = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3err('NotificationDeliveryUnsafe', message, details, true);

const runtimeContext = (
  context: SystemCommandContext<'sys_supervision'>, effectKey: string,
): CommandContext => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: deriveClientOpId(`b3v4:notification-operation:${effectKey}`),
  traceId: context.traceId,
  contractVersion: 1,
});

async function operationFor(
  core: RunsCore, effectKey: string,
): Promise<B3Result<RunOperation | null>> {
  const listed = await core.store.list<RunOperation>('runOperation');
  if (!listed.ok) return listed;
  const matching = listed.value.filter((operation) =>
    operation.kindOfOperation === 'deliver-notification'
      && operation.notificationDeliveryEffectKey === effectKey);
  if (matching.length > 1) {
    return b3fail(b3err(
      'RecoveryRequired', 'one Notification effect has more than one Runtime operation',
      { effectKey, operationIds: matching.map((operation) => operation.id) }, true,
    ));
  }
  return b3ok(matching[0] ?? null);
}

function submitted(attempt: NotificationInputAttemptFacts): Submitted {
  return attempt.outcome === 'submitted-confirmed'
    ? {
        state: 'submitted-confirmed',
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      }
    : {
        state: 'submitted-unconfirmed',
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      };
}

export async function getNotificationTurnSubmission(
  core: RunsCore, effectKey: string,
): Promise<B3Result<NotificationTurnSubmission>> {
  const found = await operationFor(core, effectKey);
  if (!found.ok) return found;
  const operation = found.value;
  const reservationId = operation?.notificationInputReservationId;
  if (operation === null || reservationId === undefined) return b3ok({ state: 'absent' });
  const reservation = await core.terminal.getNotificationInputReservation(reservationId);
  if (!reservation.ok) return reservation;
  if (reservation.value === null) return b3ok({ state: 'absent' });
  if (reservation.value.state === 'cancelled') {
    if (reservation.value.endedAt === undefined) {
      return b3fail(b3err(
        'RecoveryRequired', 'a cancelled Notification reservation has no end time',
        { notificationInputReservationId: reservationId }, true,
      ));
    }
    return b3ok({
      state: 'cancelled-not-submitted',
      notificationInputReservationId: reservationId,
      cancelledAt: reservation.value.endedAt,
    });
  }
  if (reservation.value.state === 'reserved') {
    if (core.notifications === undefined) {
      return b3fail(b3err(
        'RuntimeUnavailable', 'Supervision notification delivery is not composed',
        { reason: 'notification-delivery-not-composed' }, true,
      ));
    }
    const ownerState = await core.notifications.getDeliveryState(reader, {
      notificationId: operation.notificationId!,
      effectKey,
      notificationInputReservationId: reservationId,
    });
    if (!ownerState.ok) return ownerState;
    if (ownerState.value.state === 'submitted-confirmed'
      || ownerState.value.state === 'submitted-unconfirmed') {
      return b3fail(b3err(
        'RecoveryRequired', 'Supervision records submission before Terminal committed it',
        { notificationId: operation.notificationId, effectKey }, true,
      ));
    }
    return b3ok(ownerState.value.state === 'delivery-claimed'
      ? {
          state: 'claimed-pending-submission',
          notificationInputReservationId: reservationId,
          notificationId: operation.notificationId!,
        }
      : { state: 'reserved-not-claimed', notificationInputReservationId: reservationId });
  }
  const attemptId = reservation.value.terminalInputAttemptId;
  if (attemptId === undefined) {
    return b3fail(b3err(
      'RecoveryRequired', 'a committed Notification reservation names no Terminal attempt',
      { notificationInputReservationId: reservationId }, true,
    ));
  }
  const attempt = await core.terminal.getNotificationInputAttempt(attemptId);
  if (!attempt.ok) return attempt;
  if (attempt.value === null) {
    return b3fail(b3err(
      'RecoveryRequired', 'a committed Notification reservation lost its Terminal attempt',
      { notificationInputReservationId: reservationId, terminalInputAttemptId: attemptId }, true,
    ));
  }
  return b3ok(submitted(attempt.value));
}

async function mark(
  core: RunsCore, operation: RunOperation, stage: RunOperationStage,
  owner: string, ownerObjectId?: string,
): Promise<B3Result<RunOperation>> {
  return advance(core, operation, {
    stage,
    owner,
    ...(ownerObjectId === undefined ? {} : { ownerObjectId }),
  });
}

export async function startNotificationTurnAtSafeBoundary(
  core: RunsCore,
  context: SystemCommandContext<'sys_supervision'>,
  input: StartNotificationTurnInput,
): Promise<B3Result<Submitted>> {
  if (context.principal.kind !== 'system' || context.principal.id !== 'sys_supervision') {
    return b3fail(b3err(
      'PermissionDenied', 'only Supervision may request a Notification turn',
      { requiredPrincipal: 'sys_supervision' }, false,
    ));
  }
  const notifications = core.notifications;
  if (notifications === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'Supervision notification delivery is not composed',
      { reason: 'notification-delivery-not-composed' }, true,
    ));
  }
  const run = await requireRun(core, input.agentRunId);
  if (!run.ok) return run;
  if (run.value.lifecycle !== 'ready'
    || run.value.activity !== 'idle'
    || run.value.activeProviderTurn !== undefined
    || run.value.terminalSessionId === undefined
    || Number(run.value.activityGeneration) !== Number(input.expectedActivityGeneration)) {
    return b3fail(unsafe('the target Run is not at the requested safe boundary', {
      agentRunId: input.agentRunId,
      lifecycle: run.value.lifecycle,
      activity: run.value.activity,
      activityGeneration: run.value.activityGeneration,
    }));
  }
  const authority = await notifications.getAuthority(reader, input.notificationId);
  if (!authority.ok) return authority;
  if (authority.value.notificationId !== input.notificationId
    || authority.value.agentRunId !== input.agentRunId
    || authority.value.deliveryEffectKey !== input.effectKey
    || Number(authority.value.activityGeneration) !== Number(input.expectedActivityGeneration)
    || (authority.value.authoritySource.kind === 'watch-rule'
      && authority.value.authoritySource.watchRuleId !== authority.value.watchRuleId)
    || (authority.value.authoritySource.kind === 'launch-plan'
      && authority.value.authoritySource.launchPlanId !== run.value.launchPlanId)) {
    return b3fail(unsafe('Supervision authority does not match the requested delivery', {
      notificationId: input.notificationId, effectKey: input.effectKey,
    }));
  }
  const epochId = core.fence.activeEpochId();
  if (epochId === null) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'no active Runtime epoch can own this delivery',
      { reason: 'no-active-epoch' }, true,
    ));
  }
  const plan = await core.agents.getLaunchPlan(reader, run.value.launchPlanId);
  if (!plan.ok) return plan;
  const reservationId = notificationInputReservationId(
    input.effectKey,
  ) as NotificationInputReservationId;
  const priorOperation = await operationFor(core, input.effectKey);
  if (!priorOperation.ok) return priorOperation;
  const providerTurnId = priorOperation.value?.notificationProviderTurnId
    ?? mintProviderTurnId();
  const opened = await openOperation(core, runtimeContext(context, input.effectKey), {
    kindOfOperation: 'deliver-notification',
    runtimeEpochId: epochId,
    reserveProviderSession: false,
    notification: {
      notificationId: input.notificationId,
      effectKey: input.effectKey,
      reservationId,
      providerTurnId,
    },
  });
  if (!opened.ok) return opened;
  let operation = opened.value.operation;
  const journalled = await mark(
    core, operation, 'notification-delivery-reserved', 'agent-runtime', input.notificationId,
  );
  if (!journalled.ok) return journalled;
  operation = journalled.value;

  const reserved = await core.terminal.reserveNotificationInput({
    terminalSessionId: run.value.terminalSessionId,
    agentRunId: input.agentRunId,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    expectedActivityGeneration: input.expectedActivityGeneration,
    inputTextDigest: digest(authority.value.inputText),
    providerTurnId,
  });
  if (!reserved.ok) return reserved;
  if (reserved.value.state === 'cancelled') {
    return b3fail(b3err(
      'IdempotencyConflict', 'the deterministic Terminal reservation was cancelled',
      { notificationInputReservationId: reservationId }, false,
    ));
  }
  const terminalReserved = await mark(
    core, operation, 'terminal-input-reserved', 'terminal', reserved.value.id,
  );
  if (!terminalReserved.ok) return terminalReserved;
  operation = terminalReserved.value;

  const claimed = await notifications.claim({
    notificationId: input.notificationId,
    expectedNotificationRecordVersion: authority.value.notificationRecordVersion,
    expectedEffectKey: input.effectKey,
    notificationInputReservationId: reservationId,
    expectedActivityGeneration: input.expectedActivityGeneration,
  });
  if (!claimed.ok) {
    await core.terminal.cancelReservedNotificationInput({
      notificationInputReservationId: reservationId,
      effectKey: input.effectKey,
      reason: 'supervision-claim-rejected',
    });
    return claimed;
  }
  const supervisionClaimed = await mark(
    core, operation, 'supervision-delivery-claimed', 'supervision', input.notificationId,
  );
  if (!supervisionClaimed.ok) return supervisionClaimed;
  operation = supervisionClaimed.value;

  const typed = core.providers.deliverTurn(plan.value.provider, authority.value.inputText)
    .map((step) => step.utf8Text).join('');
  const committed = await core.terminal.commitReservedNotificationInput({
    notificationInputReservationId: reservationId,
    effectKey: input.effectKey,
    utf8Text: typed,
  });
  if (!committed.ok) return committed;
  const attempt = committed.value.attempt;
  const terminalSubmitted = await mark(
    core, operation, 'terminal-input-submitted', 'terminal', attempt.id,
  );
  if (!terminalSubmitted.ok) return terminalSubmitted;
  operation = terminalSubmitted.value;
  const outcome = submitted(attempt);

  const recorded = await notifications.recordSubmission({
    claim: claimed.value,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservationId,
    terminalInputAttemptId: attempt.id,
    outcome,
  });
  if (!recorded.ok) return recorded;
  const supervisionRecorded = await mark(
    core, operation, 'supervision-delivery-recorded', 'supervision', input.notificationId,
  );
  if (!supervisionRecorded.ok) return supervisionRecorded;
  const settled = await settleOperation(core, supervisionRecorded.value, 'completed');
  return settled.ok ? b3ok(outcome) : settled;
}

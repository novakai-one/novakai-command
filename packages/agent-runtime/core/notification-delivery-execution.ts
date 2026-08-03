// Execute the ordered Q7 saga after replay reconciliation has chosen continue.
import { createHash } from 'node:crypto';
import {
  b3err, b3fail, b3ok, deriveClientOpId, mintProviderTurnId,
  notificationInputReservationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type NotificationInputReservationId, type RuntimeEpochId,
  type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  LaunchPlanFacts, NotificationDeliveryAuthorityFacts, NotificationDeliveryClaimFacts,
  NotificationDeliveryPort, NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/index.js';
import type { AgentRun, RunOperation, RunOperationStage } from '../contract/runs.js';
import { advance, openOperation, settleOperation } from './journal.js';
import { requireRun, type RunsCore } from './runs-context.js';
import { submittedOutcome } from './notification-delivery-state.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

interface PreparedDelivery {
  readonly authority: NotificationDeliveryAuthorityFacts;
  readonly provider: LaunchPlanFacts['provider'];
  readonly runtimeEpochId: RuntimeEpochId;
  readonly terminalSessionId: TerminalSessionId;
}

interface ReservedDelivery {
  readonly operation: RunOperation;
  readonly reservationId: NotificationInputReservationId;
}

interface ClaimedDelivery extends ReservedDelivery {
  readonly claim: NotificationDeliveryClaimFacts;
}

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

function atSafeBoundary(agentRun: AgentRun, input: StartNotificationTurnInput): boolean {
  return agentRun.lifecycle === 'ready'
    && agentRun.activity === 'idle'
    && agentRun.activeProviderTurn === undefined
    && agentRun.terminalSessionId !== undefined
    && Number(agentRun.activityGeneration) === Number(input.expectedActivityGeneration);
}

function authorityMatches(
  authority: NotificationDeliveryAuthorityFacts,
  agentRun: AgentRun,
  input: StartNotificationTurnInput,
): boolean {
  const sourceMatches = authority.authoritySource.kind === 'watch-rule'
    ? authority.authoritySource.watchRuleId === authority.watchRuleId
    : authority.authoritySource.launchPlanId === agentRun.launchPlanId;
  return sourceMatches
    && authority.notificationId === input.notificationId
    && authority.agentRunId === input.agentRunId
    && authority.deliveryEffectKey === input.effectKey
    && Number(authority.activityGeneration) === Number(input.expectedActivityGeneration);
}

export async function prepareNotificationDelivery(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  input: StartNotificationTurnInput,
  ownerClaimed: boolean,
): Promise<B3Result<PreparedDelivery>> {
  const runResult = await requireRun(core, input.agentRunId);
  if (!runResult.ok) return runResult;
  if (!ownerClaimed && !atSafeBoundary(runResult.value, input)) {
    return b3fail(unsafe('the target Run is not at the requested safe boundary', {
      agentRunId: input.agentRunId,
      lifecycle: runResult.value.lifecycle,
      activity: runResult.value.activity,
      activityGeneration: runResult.value.activityGeneration,
    }));
  }
  const terminalSessionId = runResult.value.terminalSessionId;
  if (terminalSessionId === undefined) {
    return b3fail(unsafe('the target Run has no Terminal session for delivery recovery', {
      agentRunId: input.agentRunId,
      effectKey: input.effectKey,
    }));
  }
  const authority = await notifications.getAuthority(reader, input.notificationId);
  if (!authority.ok) return authority;
  if (!authorityMatches(authority.value, runResult.value, input)) {
    return b3fail(unsafe('Supervision authority does not match the requested delivery', {
      notificationId: input.notificationId, effectKey: input.effectKey,
    }));
  }
  const runtimeEpochId = core.fence.activeEpochId();
  if (runtimeEpochId === null) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'no active Runtime epoch can own this delivery',
      { reason: 'no-active-epoch' }, true,
    ));
  }
  const plan = await core.agents.getLaunchPlan(reader, runResult.value.launchPlanId);
  if (!plan.ok) return plan;
  return b3ok({
    authority: authority.value,
    provider: plan.value.provider,
    runtimeEpochId,
    terminalSessionId,
  });
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

async function reserveDelivery(
  core: RunsCore,
  context: SystemCommandContext<'sys_supervision'>,
  input: StartNotificationTurnInput,
  prepared: PreparedDelivery,
  priorOperation: RunOperation | null,
): Promise<B3Result<ReservedDelivery>> {
  const reservationId = notificationInputReservationId(
    input.effectKey,
  ) as NotificationInputReservationId;
  const providerTurnId = priorOperation?.notificationProviderTurnId ?? mintProviderTurnId();
  const opened = await openOperation(core, runtimeContext(context, input.effectKey), {
    kindOfOperation: 'deliver-notification',
    runtimeEpochId: prepared.runtimeEpochId,
    reserveProviderSession: false,
    notification: {
      notificationId: input.notificationId,
      effectKey: input.effectKey,
      reservationId,
      providerTurnId,
    },
  });
  if (!opened.ok) return opened;
  const journalled = await mark(
    core, opened.value.operation,
    'notification-delivery-reserved', 'agent-runtime', input.notificationId,
  );
  if (!journalled.ok) return journalled;
  const reserved = await core.terminal.reserveNotificationInput({
    terminalSessionId: prepared.terminalSessionId,
    agentRunId: input.agentRunId,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    expectedActivityGeneration: input.expectedActivityGeneration,
    inputTextDigest: digest(prepared.authority.inputText),
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
    core, journalled.value, 'terminal-input-reserved', 'terminal', reserved.value.id,
  );
  return terminalReserved.ok
    ? b3ok({ operation: terminalReserved.value, reservationId })
    : terminalReserved;
}

async function claimDelivery(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  input: StartNotificationTurnInput,
  authority: NotificationDeliveryAuthorityFacts,
  reserved: ReservedDelivery,
): Promise<B3Result<ClaimedDelivery>> {
  const claimed = await notifications.claim({
    notificationId: input.notificationId,
    expectedNotificationRecordVersion: authority.notificationRecordVersion,
    expectedEffectKey: input.effectKey,
    notificationInputReservationId: reserved.reservationId,
    expectedActivityGeneration: input.expectedActivityGeneration,
  });
  if (!claimed.ok) {
    await core.terminal.cancelReservedNotificationInput({
      notificationInputReservationId: reserved.reservationId,
      effectKey: input.effectKey,
      reason: 'supervision-claim-rejected',
    });
    return claimed;
  }
  const marked = await mark(
    core, reserved.operation,
    'supervision-delivery-claimed', 'supervision', input.notificationId,
  );
  return marked.ok
    ? b3ok({ operation: marked.value, reservationId: reserved.reservationId, claim: claimed.value })
    : marked;
}

async function commitDelivery(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  input: StartNotificationTurnInput,
  prepared: PreparedDelivery,
  claimed: ClaimedDelivery,
): Promise<B3Result<Submitted>> {
  const typed = core.providers.deliverTurn(prepared.provider, prepared.authority.inputText)
    .map((step) => step.utf8Text).join('');
  const committed = await core.terminal.commitReservedNotificationInput({
    notificationInputReservationId: claimed.reservationId,
    effectKey: input.effectKey,
    utf8Text: typed,
  });
  if (!committed.ok) return committed;
  const attempt = committed.value.attempt;
  const terminalSubmitted = await mark(
    core, claimed.operation, 'terminal-input-submitted', 'terminal', attempt.id,
  );
  if (!terminalSubmitted.ok) return terminalSubmitted;
  const outcome = submittedOutcome(attempt);
  const recorded = await notifications.recordSubmission({
    claim: claimed.claim,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: claimed.reservationId,
    terminalInputAttemptId: attempt.id,
    outcome,
  });
  if (!recorded.ok) return recorded;
  const supervisionRecorded = await mark(
    core, terminalSubmitted.value,
    'supervision-delivery-recorded', 'supervision', input.notificationId,
  );
  if (!supervisionRecorded.ok) return supervisionRecorded;
  const settled = await settleOperation(core, supervisionRecorded.value, 'completed');
  return settled.ok ? b3ok(outcome) : settled;
}

export async function executeNotificationDelivery(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  context: SystemCommandContext<'sys_supervision'>,
  input: StartNotificationTurnInput,
  prepared: PreparedDelivery,
  priorOperation: RunOperation | null,
): Promise<B3Result<Submitted>> {
  const reserved = await reserveDelivery(core, context, input, prepared, priorOperation);
  if (!reserved.ok) return reserved;
  const claimed = await claimDelivery(
    core, notifications, input, prepared.authority, reserved.value,
  );
  if (!claimed.ok) return claimed;
  return commitDelivery(core, notifications, input, prepared, claimed.value);
}

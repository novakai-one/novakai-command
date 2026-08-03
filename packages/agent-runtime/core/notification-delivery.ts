// Q7's Runtime-owned Notification delivery operation.
//
// This entry point owns command authority and delegates the three deep steps:
// reconcile durable owner truth, prepare the safe boundary, execute the
// journalled Terminal→Supervision sequence.
import {
  b3err, b3fail, b3ok, deriveClientOpId, notificationInputReservationId,
  type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/notification-delivery.js';
import type { RunsCore } from './runs-context.js';
import { requireRun } from './runs-context.js';
import { submitProviderTurn } from './provider-turns.js';
import { getNotificationTurnSubmission } from './notification-delivery-state.js';

export { getNotificationTurnSubmission };

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

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
  const authority = await notifications.getAuthority(
    { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, input.notificationId,
  );
  if (!authority.ok) return authority;
  if (authority.value.agentRunId !== input.agentRunId
    || authority.value.deliveryEffectKey !== input.effectKey
    || Number(authority.value.activityGeneration) !== Number(input.expectedActivityGeneration)) {
    return b3fail(b3err('NotificationDeliveryUnsafe',
      'Supervision authority does not match the requested semantic delivery', {
        notificationId: input.notificationId, effectKey: input.effectKey,
      }, true));
  }
  const run = await requireRun(core, input.agentRunId);
  if (!run.ok) return run;
  if (run.value.terminalSessionId === undefined) {
    return b3fail(b3err('NotificationDeliveryUnsafe',
      'the target Run has no managed Terminal session', {
        notificationId: input.notificationId, agentRunId: input.agentRunId,
      }, true));
  }
  const binding = await core.transcriptBinding?.(input.agentRunId);
  if (binding === undefined || binding === null) {
    return b3fail(b3err('TranscriptSourceUnavailable',
      'the Notification turn requires its exact transcript binding', {
        notificationId: input.notificationId, agentRunId: input.agentRunId,
      }, true));
  }
  const reservationId = notificationInputReservationId(input.effectKey);
  const ownerState = await notifications.getDeliveryState(
    { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, {
      notificationId: input.notificationId,
      effectKey: input.effectKey,
      notificationInputReservationId: reservationId,
    },
  );
  if (!ownerState.ok) return ownerState;
  if (ownerState.value.state === 'submitted-confirmed'
    || ownerState.value.state === 'submitted-unconfirmed') {
    const replay = await getNotificationTurnSubmission(core, input.effectKey);
    if (!replay.ok) return replay;
    return replay.value.state === 'submitted-confirmed'
      || replay.value.state === 'submitted-unconfirmed'
      ? b3ok(replay.value)
      : b3fail(b3err('RecoveryRequired',
          'Supervision records a submitted Notification without Runtime correlation', {
            notificationId: input.notificationId, effectKey: input.effectKey,
          }, true));
  }
  const submitted = await submitProviderTurn(core, {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: deriveClientOpId(`notification-provider-turn:${input.effectKey}`),
    traceId: context.traceId,
    contractVersion: 1,
    ...(core.fence.activeEpochId() === null
      ? {}
      : { runtimeEpochId: core.fence.activeEpochId()! }),
  }, {
    kind: 'runtime-effect',
    source: authority.value.semanticSource,
    sourceEffectKey: input.effectKey,
    sourceObjectRef: input.notificationId,
    agentRunId: input.agentRunId,
    terminalSessionId: run.value.terminalSessionId,
    transcriptBindingId: binding.bindingId,
    utf8Text: authority.value.inputText,
  });
  if (!submitted.ok) return submitted;
  if (submitted.value.kind === 'queued-not-yet-safe') {
    return b3fail(b3err('ProviderTurnOperationInProgress',
      'the Notification remains queued until the managed input boundary is safe', {
        agentRunId: input.agentRunId,
        providerTurnId: submitted.value.submission.providerTurnId,
        phase: 'queued',
        commandClientOpId: deriveClientOpId(`notification-provider-turn:${input.effectKey}`),
      }, true));
  }
  if (submitted.value.kind === 'not-submitted') {
    return b3fail(b3err('ProviderTurnSubmissionConflict',
      'the Notification semantic submission is terminal without a provider effect', {
        providerTurnSubmissionId: submitted.value.submission.id,
        providerTurnId: submitted.value.submission.providerTurnId,
        reason: 'not-submitted', evidenceRefs: [submitted.value.submission.id],
      }, false));
  }

  const claimed = await notifications.claim({
    notificationId: input.notificationId,
    expectedNotificationRecordVersion: authority.value.notificationRecordVersion,
    expectedEffectKey: input.effectKey,
    notificationInputReservationId: reservationId,
    expectedActivityGeneration: input.expectedActivityGeneration,
  });
  if (!claimed.ok) return claimed;
  const outcome: Submitted = submitted.value.kind === 'submitted-confirmed'
    ? {
        state: 'submitted-confirmed',
        submittedAt: submitted.value.submission.state.kind === 'submitted-confirmed'
          ? submitted.value.submission.state.submittedAt
          : submitted.value.submission.createdAt,
        providerTurnId: submitted.value.submission.providerTurnId,
      }
    : {
        state: 'submitted-unconfirmed',
        submittedAt: submitted.value.submission.state.kind === 'submitted-unconfirmed'
          ? submitted.value.submission.state.submittedAt
          : submitted.value.submission.createdAt,
        providerTurnId: submitted.value.submission.providerTurnId,
      };
  const recorded = await notifications.recordSubmission({
    claim: claimed.value,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservationId,
    terminalInputAttemptId: submitted.value.terminalInputAttemptId,
    outcome,
  });
  return recorded.ok ? b3ok(outcome) : recorded;
}

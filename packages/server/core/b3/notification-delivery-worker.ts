// One bounded Notification delivery attempt. The pump owns scheduling only.
import { createHash } from 'node:crypto';
import {
  deriveClientOpId, mintProviderTurnId, mintTraceCorrelationId,
  notificationInputReservationId,
  type ActivityGeneration, type AgentRunId, type AuthenticatedPrincipal,
  type B3ContractError, type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { AgentRunsContract, ProviderPort } from '../../../agent-runtime/contract/index.js';
import type {
  NotificationInputReservation, TerminalContract, TerminalInputAttempt,
} from '../../../terminal/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type {
  Notification, NotificationDeliveryClaim, NotificationInputReservationId,
} from '../../../supervision/contract/index.js';

export interface NotificationDeliveryDependencies {
  readonly supervision: SupervisionCore;
  readonly runs: AgentRunsContract;
  readonly terminal: TerminalContract;
  readonly providers: ProviderPort;
}

type NotificationTerminalAttempt = Extract<
  TerminalInputAttempt, { readonly source: 'system-notification' }
>;
type CommittedReservation = Extract<
  NotificationInputReservation, { readonly state: 'committed' }
>;
type DeliveryTarget = {
  readonly agentRunId: AgentRunId;
  readonly effectKey: string;
  readonly claimGeneration: ActivityGeneration;
  readonly inputText: string;
};

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

function runtimeContext(
  effectKey: string, step: string,
): SystemCommandContext<'sys_agent_runtime'> {
  return {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: deriveClientOpId(`${effectKey}:${step}`),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

function supervisionContext(
  effectKey: string,
): SystemCommandContext<'sys_supervision'> {
  return {
    principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
    clientOpId: deriveClientOpId(`${effectKey}:start-notification-turn`),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const logicalDigest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

async function recordOutcome(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
  claimed: NotificationDeliveryClaim,
  reservation: NotificationInputReservationId,
  attempt: NotificationTerminalAttempt,
): Promise<string> {
  const submission = attempt.outcome === 'submitted-confirmed'
    ? {
        state: 'submitted-confirmed' as const,
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      }
    : {
        state: 'submitted-unconfirmed' as const,
        submittedAt: attempt.submittedAt,
        providerTurnId: attempt.providerTurnId,
      };
  if (notification.phase === 'drift-status-request') {
    const deadline = claimed.watchDeadline;
    if (deadline === undefined) return 'WatcherConflict';
    const outcome = await dependencies.supervision.recordDriftStatusSubmission(
      runtimeContext(notification.deliveryEffectKey, 'record-drift-outcome'),
      {
        watchDeadlineId: deadline.id,
        expectedRecordVersion: deadline.recordVersion,
        expectedEpisodeId: notification.driftEpisodeId,
        expectedEffectKey: notification.deliveryEffectKey,
        expectedNotificationId: notification.id,
        expectedNotificationInputReservationId: reservation,
        expectedTerminalInputAttemptId: attempt.id,
        submission,
      },
    );
    return outcome.ok ? '' : outcome.error.code;
  }
  const outcome = await dependencies.supervision.recordNotificationDeliveryOutcome(
    runtimeContext(notification.deliveryEffectKey, 'record-outcome'), {
      notificationId: notification.id,
      expectedRecordVersion: claimed.notification.recordVersion,
      expectedEffectKey: notification.deliveryEffectKey,
      notificationInputReservationId: reservation,
      terminalInputAttemptId: attempt.id,
      outcome: submission,
    },
  );
  return outcome.ok ? '' : outcome.error.code;
}

async function claim(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
  target: DeliveryTarget,
  reservation: NotificationInputReservationId,
): Promise<B3Result<NotificationDeliveryClaim>> {
  return dependencies.supervision.claimNotificationDelivery(
    runtimeContext(target.effectKey, 'claim'),
    {
      notificationId: notification.id,
      expectedNotificationRecordVersion: notification.recordVersion,
      expectedEffectKey: target.effectKey,
      notificationInputReservationId: reservation,
      expectedActivityGeneration: target.claimGeneration,
    },
  );
}

/**
 * Release the Terminal input fence, but ONLY for a failure that can never
 * succeed.
 *
 * The reservation id is derived from the delivery effect key, so it is
 * permanent: a cancelled reservation is met again by every later pass and
 * turned into `IdempotencyConflict` for ever. Cancelling on a RETRYABLE
 * failure therefore converts one transient refusal into a Notification no pass
 * can ever deliver. Leaving a NON-retryable one reserved is the opposite
 * defect: `requireAvailableBoundary` then refuses every other Notification on
 * that terminal session with `InputLeaseBusy` for the life of the process.
 *
 * The error's own `retryable` flag is the only thing that separates the two,
 * and it is already carried by every refusal in the vocabulary.
 */
async function releaseDeadEndReservation(
  dependencies: NotificationDeliveryDependencies,
  target: DeliveryTarget,
  reservation: NotificationInputReservationId,
  error: B3ContractError,
  reason: 'supervision-claim-rejected' | 'runtime-compensation',
): Promise<void> {
  if (error.retryable) return;
  await dependencies.terminal.cancelReservedNotificationInput(
    runtimeContext(target.effectKey, 'cancel-terminal-input'),
    { notificationInputReservationId: reservation, effectKey: target.effectKey, reason },
  );
}

function committedTupleMatches(
  held: CommittedReservation,
  notification: Notification,
  target: DeliveryTarget,
): boolean {
  return held.agentRunId === target.agentRunId
    && held.notificationId === notification.id
    && held.deliveryEffectKey === target.effectKey;
}

function attemptMatches(
  attempt: TerminalInputAttempt,
  reservation: NotificationInputReservationId,
  target: DeliveryTarget,
): attempt is NotificationTerminalAttempt {
  return attempt.source === 'system-notification'
    && attempt.notificationInputReservationId === reservation
    && attempt.deliveryEffectKey === target.effectKey;
}

async function replayCommitted(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
  target: DeliveryTarget,
  reservation: NotificationInputReservationId,
  held: CommittedReservation,
): Promise<string> {
  if (!committedTupleMatches(held, notification, target)) return 'IdempotencyConflict';
  const attempt = await dependencies.terminal.getTerminalInputAttempt(
    reader, held.terminalInputAttemptId,
  );
  if (!attempt.ok) return attempt.error.code;
  if (!attemptMatches(attempt.value, reservation, target)) return 'IdempotencyConflict';
  const claimed = await claim(dependencies, notification, target, reservation);
  if (!claimed.ok) return claimed.error.code;
  return recordOutcome(dependencies, notification, claimed.value, reservation, attempt.value);
}

function runCanCarryContext(
  runTruth: Awaited<ReturnType<AgentRunsContract['getAgentRun']>> extends infer Result
    ? Result extends { readonly ok: true; readonly value: infer Value }
      ? Value extends { readonly run: infer Run } ? Run : never
      : never
    : never,
  target: DeliveryTarget,
): boolean {
  return runTruth.lifecycle === 'ready'
    && runTruth.activity === 'idle'
    && runTruth.activeProviderTurn === undefined
    && runTruth.terminalSessionId !== undefined
    && Number(runTruth.activityGeneration) > Number(target.claimGeneration);
}

async function submitNextTurn(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
  target: DeliveryTarget,
  reservation: NotificationInputReservationId,
  prior: NotificationInputReservation | null,
): Promise<string | null> {
  const runResult = await dependencies.runs.getAgentRun(reader, target.agentRunId);
  if (!runResult.ok) return runResult.error.code;
  const runTruth = runResult.value.run;
  if (!runCanCarryContext(runTruth, target) || runTruth.terminalSessionId === undefined) return null;
  const terminal = await dependencies.terminal.getTerminalSession(reader, runTruth.terminalSessionId);
  if (!terminal.ok) return terminal.error.code;
  if (terminal.value.session.status !== 'live'
    || terminal.value.activeInputLease !== undefined) return null;
  const providerTurnId = prior?.providerTurnId ?? mintProviderTurnId();
  const reserved = await dependencies.terminal.reserveNotificationInput(
    runtimeContext(target.effectKey, 'reserve-terminal-input'),
    {
      terminalSessionId: runTruth.terminalSessionId,
      agentRunId: target.agentRunId,
      notificationId: notification.id,
      effectKey: target.effectKey,
      expectedActivityGeneration: prior?.expectedActivityGeneration ?? runTruth.activityGeneration,
      inputTextDigest: logicalDigest(target.inputText),
      providerTurnId,
    },
  );
  if (!reserved.ok) return reserved.error.code;
  if (reserved.value.state === 'cancelled') return 'IdempotencyConflict';
  const claimed = await claim(dependencies, notification, target, reservation);
  if (!claimed.ok) {
    await releaseDeadEndReservation(
      dependencies, target, reservation, claimed.error, 'supervision-claim-rejected',
    );
    return claimed.error.code;
  }
  const submitted = await dependencies.terminal.commitReservedNotificationInput(
    runtimeContext(target.effectKey, 'commit-terminal-input'),
    {
      notificationInputReservationId: reservation,
      effectKey: target.effectKey,
      utf8Text: dependencies.providers.deliverTurn(
        runResult.value.provider.provider, target.inputText,
      ).map((step) => step.utf8Text).join(''),
    },
  );
  if (!submitted.ok) {
    await releaseDeadEndReservation(
      dependencies, target, reservation, submitted.error, 'runtime-compensation',
    );
    return submitted.error.code;
  }
  return recordOutcome(
    dependencies, notification, claimed.value, reservation, submitted.value.attempt,
  );
}

async function deliverNextTurn(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
): Promise<string | null> {
  const occurrenceRunId = notification.schemaVersion === 2
    && notification.occurrenceIdentity !== 'legacy-generation'
    ? notification.conditionOccurrence.agentRunId
    : undefined;
  const agentRunId = notification.schemaVersion === 2
    && notification.deliveryFence !== undefined
    ? notification.deliveryFence.targetAgentRunId
    : notification.subject.kind === 'agent-run'
      ? notification.subject.agentRunId
      : occurrenceRunId;
  if (agentRunId === undefined) return 'NotificationDeliveryUnsafe';
  const target: DeliveryTarget = {
    agentRunId,
    effectKey: notification.deliveryEffectKey,
    claimGeneration: (notification.schemaVersion === 2
      ? notification.deliveryFence?.baselineActivityGeneration
        ?? notification.conditionGeneration
      : notification.conditionGeneration) as ActivityGeneration,
    inputText: notification.summary,
  };
  const reservation = notificationInputReservationId(
    target.effectKey,
  ) as NotificationInputReservationId;
  const prior = await dependencies.terminal.getNotificationInputReservation(reader, reservation);
  if (!prior.ok && prior.error.code !== 'ValidationFailed') return prior.error.code;
  if (prior.ok && prior.value.state === 'committed') {
    return replayCommitted(dependencies, notification, target, reservation, prior.value);
  }
  return submitNextTurn(
    dependencies, notification, target, reservation, prior.ok ? prior.value : null,
  );
}

async function deliverStartTurn(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
): Promise<string> {
  if (notification.subject.kind !== 'agent-run') return 'NotificationDeliveryUnsafe';
  const outcome = await dependencies.runs.startNotificationTurnAtSafeBoundary(
    supervisionContext(notification.deliveryEffectKey),
    {
      notificationId: notification.id,
      agentRunId: notification.subject.agentRunId,
      effectKey: notification.deliveryEffectKey,
      expectedActivityGeneration: notification.conditionGeneration as ActivityGeneration,
    },
  );
  return outcome.ok ? '' : outcome.error.code;
}

export async function deliverNotification(
  dependencies: NotificationDeliveryDependencies,
  notification: Notification,
): Promise<string | null> {
  if (notification.deliveryMode === 'queue-only') return null;
  return notification.deliveryMode === 'start-turn'
    ? deliverStartTurn(dependencies, notification)
    : deliverNextTurn(dependencies, notification);
}

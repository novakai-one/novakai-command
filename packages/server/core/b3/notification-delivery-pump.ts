// Runtime-side delivery of Supervision-owned Notifications.
//
// Supervision owns queue/claim/outcome truth; Agent Runtime owns Run activity;
// Terminal owns input serialization; provider adapters own how a turn is typed.
// This composition module coordinates those public interfaces and writes none
// of their records directly.
import { createHash } from 'node:crypto';
import {
  deriveClientOpId, mintProviderTurnId, mintTraceCorrelationId,
  notificationInputReservationId,
  type ActivityGeneration, type AgentRunId, type AuthenticatedPrincipal,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { AgentRunsContract, ProviderPort } from '../../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type {
  Notification, NotificationInputReservationId,
} from '../../../supervision/contract/index.js';

export interface NotificationDeliveryPass {
  readonly considered: number;
  readonly delivered: number;
  readonly failures: readonly { readonly notificationId: string; readonly code: string }[];
}

export interface NotificationDeliveryPump {
  deliverOnce(): Promise<NotificationDeliveryPass>;
  start(): void;
  stop(): Promise<void>;
}

export interface NotificationDeliveryPumpOptions {
  readonly supervision: SupervisionCore;
  readonly runs: AgentRunsContract;
  readonly terminal: TerminalContract;
  readonly providers: ProviderPort;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 500;
const LIMIT = 100;
const EMPTY: NotificationDeliveryPass = { considered: 0, delivered: 0, failures: [] };

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

const logicalDigest = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

function pending(notification: Notification): boolean {
  return notification.deliveryAttempt.state === 'queued'
    || notification.deliveryAttempt.state === 'delivery-claimed';
}

function needsDriftOutcomeReconcile(
  notification: Notification, claimedDriftEffects: ReadonlySet<string>,
): boolean {
  return notification.phase === 'drift-status-request'
    && (notification.deliveryAttempt.state === 'submitted-confirmed'
      || notification.deliveryAttempt.state === 'submitted-unconfirmed')
    && claimedDriftEffects.has(notification.deliveryEffectKey);
}

/** Create a bounded, restart-scanning Runtime delivery loop. */
export function createNotificationDeliveryPump(
  options: NotificationDeliveryPumpOptions,
): NotificationDeliveryPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<NotificationDeliveryPass> | null = null;

  async function deliver(notification: Notification): Promise<string | null> {
    // queue-only is durable UI truth. start-turn carries explicit policy
    // authority; next-turn-context gains execution authority only after the
    // Run's activity generation proves another turn happened first.
    if (notification.deliveryMode === 'queue-only') return null;
    let target: {
      readonly agentRunId: AgentRunId;
      readonly effectKey: string;
      readonly claimGeneration: ActivityGeneration;
      readonly inputText: string;
    };
    if (notification.deliveryMode === 'start-turn') {
      const authority = await options.supervision.getNotificationDeliveryAuthority(
        reader, notification.id,
      );
      if (!authority.ok) return authority.error.code;
      target = {
        agentRunId: authority.value.agentRunId,
        effectKey: authority.value.deliveryEffectKey,
        claimGeneration: authority.value.activityGeneration,
        inputText: authority.value.inputText,
      };
    } else {
      if (notification.subject.kind !== 'agent-run') return 'NotificationDeliveryUnsafe';
      target = {
        agentRunId: notification.subject.agentRunId,
        effectKey: notification.deliveryEffectKey,
        claimGeneration: notification.conditionGeneration as ActivityGeneration,
        inputText: notification.summary,
      };
    }

    const run = await options.runs.getAgentRun(reader, target.agentRunId);
    if (!run.ok) return run.error.code;
    const runTruth = run.value.run;
    if (runTruth.lifecycle !== 'ready'
      || runTruth.activity !== 'idle'
      || runTruth.activeProviderTurn !== undefined
      || runTruth.terminalSessionId === undefined) {
      return null;
    }
    if (notification.deliveryMode === 'start-turn'
      && Number(runTruth.activityGeneration) !== Number(target.claimGeneration)) return null;
    if (notification.deliveryMode === 'next-turn-context'
      && Number(runTruth.activityGeneration) <= Number(target.claimGeneration)) return null;

    const terminal = await options.terminal.getTerminalSession(
      reader, runTruth.terminalSessionId,
    );
    if (!terminal.ok) return terminal.error.code;
    if (terminal.value.session.status !== 'live'
      || terminal.value.activeInputLease !== undefined) return null;

    const reservation = notificationInputReservationId(
      target.effectKey,
    ) as NotificationInputReservationId;
    const priorReservation = await options.terminal.getNotificationInputReservation(
      reader, reservation,
    );
    if (!priorReservation.ok && priorReservation.error.code !== 'ValidationFailed') {
      return priorReservation.error.code;
    }
    const providerTurnId = priorReservation.ok
      ? priorReservation.value.providerTurnId : mintProviderTurnId();
    const reserved = await options.terminal.reserveNotificationInput(
      runtimeContext(target.effectKey, 'reserve-terminal-input'),
      {
        terminalSessionId: runTruth.terminalSessionId,
        agentRunId: target.agentRunId,
        notificationId: notification.id,
        effectKey: target.effectKey,
        expectedActivityGeneration: priorReservation.ok
          ? priorReservation.value.expectedActivityGeneration
          : runTruth.activityGeneration,
        inputTextDigest: logicalDigest(target.inputText),
        providerTurnId,
      },
    );
    if (!reserved.ok) return reserved.error.code;
    if (reserved.value.state === 'cancelled') return 'IdempotencyConflict';

    const claimed = await options.supervision.claimNotificationDelivery(
      runtimeContext(target.effectKey, 'claim'),
      {
        notificationId: notification.id,
        expectedNotificationRecordVersion: notification.recordVersion,
        expectedEffectKey: target.effectKey,
        notificationInputReservationId: reservation,
        expectedActivityGeneration: target.claimGeneration,
      },
    );
    if (!claimed.ok) {
      await options.terminal.cancelReservedNotificationInput(
        runtimeContext(target.effectKey, 'cancel-terminal-input'),
        {
          notificationInputReservationId: reservation,
          effectKey: target.effectKey,
          reason: 'supervision-claim-rejected',
        },
      );
      return claimed.error.code;
    }

    const submitted = await options.terminal.commitReservedNotificationInput(
      runtimeContext(target.effectKey, 'commit-terminal-input'),
      {
        notificationInputReservationId: reservation,
        effectKey: target.effectKey,
        utf8Text: options.providers.deliverTurn(
          run.value.provider.provider, target.inputText,
        ).map((step) => step.utf8Text).join(''),
      },
    );
    if (!submitted.ok) return submitted.error.code;

    const attempt = submitted.value.attempt;
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
      const deadline = claimed.value.watchDeadline;
      if (deadline === undefined) return 'WatcherConflict';
      const outcome = await options.supervision.recordDriftStatusSubmission(
        runtimeContext(target.effectKey, 'record-drift-outcome'),
        {
          watchDeadlineId: deadline.id,
          expectedRecordVersion: deadline.recordVersion,
          expectedEpisodeId: notification.driftEpisodeId,
          expectedEffectKey: target.effectKey,
          expectedNotificationId: notification.id,
          expectedNotificationInputReservationId: reservation,
          expectedTerminalInputAttemptId: attempt.id,
          submission,
        },
      );
      return outcome.ok ? '' : outcome.error.code;
    }
    const outcome = await options.supervision.recordNotificationDeliveryOutcome(
      runtimeContext(target.effectKey, 'record-outcome'), {
        notificationId: notification.id,
        expectedRecordVersion: claimed.value.notification.recordVersion,
        expectedEffectKey: target.effectKey,
        notificationInputReservationId: reservation,
        terminalInputAttemptId: attempt.id,
        outcome: submission,
      },
    );
    return outcome.ok ? '' : outcome.error.code;
  }

  async function runPass(): Promise<NotificationDeliveryPass> {
    const listed = await options.supervision.listNotifications(reader, {
      state: ['queued', 'offered-to-endpoint', 'delivery-uncertain'], limit: LIMIT,
    });
    if (!listed.ok) {
      return { ...EMPTY, failures: [{ notificationId: '', code: listed.error.code }] };
    }
    const deadlines = await options.supervision.listWatchDeadlines(reader);
    if (!deadlines.ok) {
      return { ...EMPTY, failures: [{ notificationId: '', code: deadlines.error.code }] };
    }
    const claimedDriftEffects = new Set(deadlines.value.flatMap((deadline) => {
      const drift = deadline.driftState;
      return drift?.phase === 'status-outstanding'
        && drift.outstandingStatus.state === 'delivery-claimed'
        ? [drift.outstandingStatus.effectKey] : [];
    }));
    const candidates = listed.value.items.filter((notification) =>
      pending(notification) || needsDriftOutcomeReconcile(notification, claimedDriftEffects));
    const awaitingRuns = new Set(listed.value.items.flatMap((notification) =>
      !pending(notification)
        && !needsDriftOutcomeReconcile(notification, claimedDriftEffects)
        && notification.subject.kind === 'agent-run'
        ? [String(notification.subject.agentRunId)] : []));
    let delivered = 0;
    const failures: { notificationId: string; code: string }[] = [];
    const attemptedRuns = new Set<string>();
    for (const notification of candidates) {
      const runKey = notification.subject.kind === 'agent-run'
        ? String(notification.subject.agentRunId) : '';
      if (runKey !== '' && awaitingRuns.has(runKey)) continue;
      if (runKey !== '' && attemptedRuns.has(runKey)) continue;
      const code = await deliver(notification);
      if (code === '') {
        delivered += 1;
        if (runKey !== '') attemptedRuns.add(runKey);
      } else if (code !== null) {
        failures.push({ notificationId: notification.id, code });
      }
    }
    return { considered: candidates.length, delivered, failures };
  }

  async function deliverOnce(): Promise<NotificationDeliveryPass> {
    if (inFlight !== null) return inFlight;
    const pass = runPass().finally(() => { inFlight = null; });
    inFlight = pass;
    return pass;
  }

  return {
    deliverOnce,
    start() {
      if (timer !== null) return;
      void deliverOnce();
      timer = setInterval(() => { void deliverOnce(); }, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (inFlight !== null) await inFlight;
    },
  };
}

// Runtime-side delivery of Supervision-owned Notifications.
//
// Supervision owns queue/claim/outcome truth; Agent Runtime owns Run activity;
// Terminal owns input serialization; provider adapters own how a turn is typed.
// This composition module coordinates those public interfaces and writes none
// of their records directly.
import {
  deriveClientOpId, deterministicId, mintProviderTurnId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type CommandContext, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  AgentRunsContract, ProviderPort, TerminalPort,
} from '../../../agent-runtime/contract/index.js';
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
  readonly terminalEffects: TerminalPort;
  readonly providers: ProviderPort;
  readonly intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 500;
const LIMIT = 100;
const EMPTY: NotificationDeliveryPass = { considered: 0, delivered: 0, failures: [] };

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

function effectContext(effectKey: string, step: string): CommandContext {
  return {
    principal: reader,
    clientOpId: deriveClientOpId(`${effectKey}:${step}`),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

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

function reservationId(effectKey: string): NotificationInputReservationId {
  return deterministicId(
    'notificationInput', ['notification-input', effectKey],
  ) as NotificationInputReservationId;
}

function pending(notification: Notification): boolean {
  return notification.deliveryAttempt.state === 'queued'
    || notification.deliveryAttempt.state === 'delivery-claimed';
}

/** Create a bounded, restart-scanning Runtime delivery loop. */
export function createNotificationDeliveryPump(
  options: NotificationDeliveryPumpOptions,
): NotificationDeliveryPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<NotificationDeliveryPass> | null = null;

  async function deliver(notification: Notification): Promise<string | null> {
    // Only this mode authorises a new provider turn. queue-only is durable UI
    // truth; next-turn-context is consumed by a separately caused turn.
    if (notification.deliveryMode !== 'start-turn') return null;
    const authority = await options.supervision.getNotificationDeliveryAuthority(
      reader, notification.id,
    );
    if (!authority.ok) return authority.error.code;

    const run = await options.runs.getAgentRun(reader, authority.value.agentRunId);
    if (!run.ok) return run.error.code;
    const runTruth = run.value.run;
    if (runTruth.lifecycle !== 'ready'
      || runTruth.activity !== 'idle'
      || runTruth.activeProviderTurn !== undefined
      || runTruth.terminalSessionId === undefined
      || Number(runTruth.activityGeneration) !== Number(authority.value.activityGeneration)) {
      return null;
    }

    const terminal = await options.terminal.getTerminalSession(
      reader, runTruth.terminalSessionId,
    );
    if (!terminal.ok) return terminal.error.code;
    if (terminal.value.session.status !== 'live'
      || terminal.value.activeInputLease !== undefined) return null;

    const reservation = reservationId(authority.value.deliveryEffectKey);
    const claimed = await options.supervision.claimNotificationDelivery(
      runtimeContext(authority.value.deliveryEffectKey, 'claim'),
      {
        notificationId: authority.value.notificationId,
        expectedNotificationRecordVersion: authority.value.notificationRecordVersion,
        expectedEffectKey: authority.value.deliveryEffectKey,
        notificationInputReservationId: reservation,
        expectedActivityGeneration: authority.value.activityGeneration,
      },
    );
    if (!claimed.ok) return claimed.error.code;

    const submitted = await options.terminalEffects.submitRuntimeInput(
      effectContext(authority.value.deliveryEffectKey, 'terminal-input'),
      {
        terminalSessionId: runTruth.terminalSessionId,
        keystrokes: options.providers.deliverTurn(
          run.value.provider.provider, authority.value.inputText,
        ),
        effectKey: authority.value.deliveryEffectKey,
      },
    );
    if (!submitted.ok) return submitted.error.code;

    const outcome = await options.supervision.recordNotificationDeliveryOutcome(
      runtimeContext(authority.value.deliveryEffectKey, 'record-outcome'),
      {
        notificationId: notification.id,
        expectedRecordVersion: claimed.value.notification.recordVersion,
        expectedEffectKey: authority.value.deliveryEffectKey,
        notificationInputReservationId: reservation,
        terminalInputAttemptId: submitted.value.terminalInputAttemptId,
        outcome: submitted.value.confirmed
          ? {
              state: 'submitted-confirmed',
              submittedAt: submitted.value.submittedAt,
              providerTurnId: mintProviderTurnId(),
            }
          : {
              state: 'submitted-unconfirmed',
              submittedAt: submitted.value.submittedAt,
            },
      },
    );
    return outcome.ok ? '' : outcome.error.code;
  }

  async function runPass(): Promise<NotificationDeliveryPass> {
    const listed = await options.supervision.listNotifications(reader, {
      state: ['queued', 'offered-to-endpoint'], limit: LIMIT,
    });
    if (!listed.ok) {
      return { ...EMPTY, failures: [{ notificationId: '', code: listed.error.code }] };
    }
    const candidates = listed.value.items.filter(pending);
    let delivered = 0;
    const failures: { notificationId: string; code: string }[] = [];
    const attemptedRuns = new Set<string>();
    for (const notification of candidates) {
      const runKey = notification.subject.kind === 'agent-run'
        ? String(notification.subject.agentRunId) : '';
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

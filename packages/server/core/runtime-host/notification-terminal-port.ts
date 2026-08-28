// Terminal's narrow Q7 adapter for Agent Runtime Notification delivery.
import {
  b3err, b3fail, b3ok, deriveClientOpId, mintClientOpId, mintTraceCorrelationId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { TerminalPort } from '../../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';

type NotificationTerminalPort = Pick<
  TerminalPort,
  'reserveNotificationInput' | 'commitReservedNotificationInput'
  | 'cancelReservedNotificationInput' | 'getNotificationInputReservation'
  | 'getNotificationInputAttempt'
>;

const contextFor = (
  effectKey: string, step: string,
): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: deriveClientOpId(`${effectKey}:${step}`),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

const readerContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

export function notificationTerminalPort(
  terminal: TerminalContract,
): NotificationTerminalPort {
  return {
    reserveNotificationInput: (input) => terminal.reserveNotificationInput(
      contextFor(input.effectKey, 'reserve-terminal-input'), input,
    ),
    commitReservedNotificationInput: (input) => terminal.commitReservedNotificationInput(
      contextFor(input.effectKey, 'commit-terminal-input'), input,
    ),
    cancelReservedNotificationInput: (input) => terminal.cancelReservedNotificationInput(
      contextFor(input.effectKey, 'cancel-terminal-input'), input,
    ),
    async getNotificationInputReservation(notificationInputReservationId) {
      const found = await terminal.getNotificationInputReservation(
        readerContext().principal, notificationInputReservationId,
      );
      if (!found.ok && found.error.code === 'ValidationFailed') return b3ok(null);
      return found;
    },
    async getNotificationInputAttempt(terminalInputAttemptId) {
      const found = await terminal.getTerminalInputAttempt(
        readerContext().principal, terminalInputAttemptId,
      );
      if (!found.ok && found.error.code === 'ValidationFailed') return b3ok(null);
      if (!found.ok) return found;
      if (found.value.source !== 'system-notification') {
        return b3fail(b3err(
          'RecoveryRequired', 'Notification reservation names a controller input attempt',
          { terminalInputAttemptId }, true,
        ));
      }
      return b3ok({
        id: found.value.id,
        notificationInputReservationId: found.value.notificationInputReservationId,
        deliveryEffectKey: found.value.deliveryEffectKey,
        providerTurnId: found.value.providerTurnId,
        outcome: found.value.outcome,
        submittedAt: found.value.submittedAt,
      });
    },
  };
}

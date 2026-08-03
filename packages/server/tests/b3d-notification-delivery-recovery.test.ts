// FINDING-C7 restart scanner — recover the approved sequential drift split.
//
// A process may stop after the Notification outcome CAS but before the matching
// WatchDeadline CAS. The next pump must therefore re-read claimed deadline
// effect keys and replay the same Runtime operation; a submitted Notification
// alone is not evidence that the sequential operation is complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  b3ok, notificationInputReservationId,
  type ActivityGeneration, type AgentRunId, type NotificationId,
} from '@novakai/foundation/contract';
import type { AgentRunsContract, ProviderPort } from '../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../terminal/contract/index.js';
import type { SupervisionCore } from '../../supervision/public/index.js';
import type { Notification, WatchDeadline } from '../../supervision/contract/index.js';
import { createNotificationDeliveryPump } from '../core/b3/notification-delivery-pump.js';

test('a fresh Runtime pass replays a submitted drift Notification whose deadline is still claimed',
  async () => {
    const notificationId = `notification_${'e'.repeat(52)}` as NotificationId;
    const agentRunId = `agentRun_${'f'.repeat(52)}` as AgentRunId;
    const effectKey = `b3v4:notification-delivery:${notificationId}:drift`;
    const reservationId = notificationInputReservationId(effectKey);
    const generation = 7 as ActivityGeneration;
    const notification = {
      id: notificationId,
      phase: 'drift-status-request',
      subject: { kind: 'agent-run', agentRunId },
      deliveryMode: 'start-turn',
      deliveryEffectKey: effectKey,
      conditionGeneration: generation,
      deliveryAttempt: {
        state: 'submitted-confirmed',
        effectKey,
        notificationInputReservationId: reservationId,
      },
    } as unknown as Notification;
    const deadline = {
      driftState: {
        phase: 'status-outstanding',
        outstandingStatus: { state: 'delivery-claimed', effectKey },
      },
    } as unknown as WatchDeadline;
    const starts: unknown[] = [];
    const supervision = {
      listNotifications: async () => b3ok({ items: [notification] }),
      listWatchDeadlines: async () => b3ok([deadline]),
    } as unknown as SupervisionCore;
    const runs = {
      async startNotificationTurnAtSafeBoundary(_context: unknown, input: unknown) {
        starts.push(input);
        return b3ok({
          state: 'submitted-confirmed' as const,
          submittedAt: '2026-08-03T00:02:00.000Z' as never,
          providerTurnId: `providerTurn_${'g'.repeat(52)}` as never,
        });
      },
    } as unknown as AgentRunsContract;
    const pump = createNotificationDeliveryPump({
      supervision,
      runs,
      // A start-turn replay must remain behind the Runtime command. If this
      // scanner reaches either direct port, the test throws at the call site.
      terminal: {} as TerminalContract,
      providers: {} as ProviderPort,
    });
    try {
      const pass = await pump.deliverOnce();
      assert.deepEqual(pass, { considered: 1, delivered: 1, failures: [] });
      assert.deepEqual(starts, [{
        notificationId,
        agentRunId,
        effectKey,
        expectedActivityGeneration: generation,
      }]);
    } finally {
      await pump.stop();
    }
  });

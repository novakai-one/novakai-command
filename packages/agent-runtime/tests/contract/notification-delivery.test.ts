// Q7 — Agent Runtime owns durable Notification delivery orchestration.
//
// These tests stay on the public Runtime interface. Terminal and Supervision
// vary through the same ports production composition uses; the test never
// reaches Runtime's store or delivery implementation directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AuthenticatedPrincipal, B3Result, NotificationInputReservationId,
} from '@novakai/foundation/contract';
import type { ComposedAgentRuns } from '../../core/runs-compose.js';
import { createRunsRig } from '../runs-harness.js';

type NotificationTurnSubmission =
  | { readonly state: 'submitted-confirmed'; readonly submittedAt: string }
  | { readonly state: 'submitted-unconfirmed'; readonly submittedAt: string }
  | { readonly state: 'absent' }
  | {
      readonly state: 'reserved-not-claimed';
      readonly notificationInputReservationId: NotificationInputReservationId;
    }
  | {
      readonly state: 'claimed-pending-submission';
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly notificationId: string;
    }
  | {
      readonly state: 'cancelled-not-submitted';
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly cancelledAt: string;
    };

interface NotificationRuntime extends ComposedAgentRuns {
  getNotificationTurnSubmission(
    principal: AuthenticatedPrincipal,
    effectKey: string,
  ): Promise<B3Result<NotificationTurnSubmission>>;
}

test('an unseen Notification delivery effect has durable state absent', async () => {
  const rig = createRunsRig();
  try {
    const runtime = rig.runtime as NotificationRuntime;
    const found = await runtime.getNotificationTurnSubmission(
      rig.principal(), 'b3v4:notification-delivery:notification_missing:condition',
    );
    assert.equal(found.ok, true, found.ok ? '' : found.error.message);
    if (found.ok) assert.deepEqual(found.value, { state: 'absent' });
  } finally {
    rig.close();
  }
});

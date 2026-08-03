// Q7 — Agent Runtime owns durable Notification delivery orchestration.
//
// These tests stay on the public Runtime interface. Terminal and Supervision
// vary through the same ports production composition uses; the test never
// reaches Runtime's store or delivery implementation directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunsRig } from '../runs-harness.js';

test('an unseen Notification delivery effect has durable state absent', async () => {
  const rig = createRunsRig();
  try {
    const found = await rig.runtime.getNotificationTurnSubmission(
      rig.principal(), 'b3v4:notification-delivery:notification_missing:condition',
    );
    assert.equal(found.ok, true, found.ok ? '' : found.error.message);
    if (found.ok) assert.deepEqual(found.value, { state: 'absent' });
  } finally {
    rig.close();
  }
});

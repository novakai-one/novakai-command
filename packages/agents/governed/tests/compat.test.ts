import assert from 'node:assert/strict';
import test from 'node:test';
import { compatiblePlan, compatibleRole } from '../core/compat.js';

test('legacy schema-v1 supervision policy normalizes to the explicit opt-out', () => {
  const legacy = {
    supervisionPolicy: {
      requiredWatcherTemplates: [],
      parentNotificationMode: 'queue-only',
    },
  };
  assert.equal(compatibleRole(legacy as never).supervisionPolicy.activityDrift,
    'disabled-explicitly');
  assert.equal(compatiblePlan(legacy as never).supervisionPolicy.activityDrift,
    'disabled-explicitly');
  assert.equal('activityDrift' in legacy.supervisionPolicy, false,
    'read normalization mutated the historical record');
});

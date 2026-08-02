import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPERVISION_CLI_COMMANDS,
  SUPERVISION_EVENT_KINDS,
  watchRemoveRetirement,
  SUPERVISION_NOTIFICATION_SUBSCRIBE_METHOD,
  SUPERVISION_NOTIFICATION_PUSH_EVENT,
  ACTIVITY_DRIFT_TEMPLATE_REF,
  SUPERVISION_WATCH_START_TURN_SCOPE,
  requiresWatchStartTurnAuthority,
  roleRequiresWatchStartTurnAuthority,
} from '../contract/index.js';
import { installedWatchRules } from './fixtures.js';

test('the frozen public event surface contains exactly the §15 supervision rows', () => {
  assert.deepEqual(SUPERVISION_EVENT_KINDS, [
    'supervision.deadline.changed',
    'supervision.notification.changed',
    'supervision.drift.ping',
    'supervision.drift.cleared',
    'supervision.drift.detected',
    'supervision.drift.escalated',
  ]);
});

test('activity drift is the sole implicit template and pins scoped start-turn authority', () => {
  assert.deepEqual(ACTIVITY_DRIFT_TEMPLATE_REF, {
    id: 'watch-template/activity-drift',
    version: 1,
    digest: '0670a8e2dad3c381bf6cf845da23287f568eb105209b391d59a637d1cd0022d4',
  });
  assert.equal(SUPERVISION_WATCH_START_TURN_SCOPE, 'supervision:watch:start-turn');
  assert.equal(roleRequiresWatchStartTurnAuthority({
    activityDrift: 'required',
    requiredWatcherTemplates: [],
    parentNotificationMode: 'queue-only',
  }), true);
  assert.equal(requiresWatchStartTurnAuthority({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' as never },
    condition: { kind: 'run-final' },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    deliveryMode: 'start-turn',
    cooldownMs: 0,
    status: 'active',
  }), true);
});

test('notification wire subscription reuses bounded pages and the generic event name', () => {
  assert.equal(
    SUPERVISION_NOTIFICATION_SUBSCRIBE_METHOD,
    'b3.supervision.subscribeNotifications',
  );
  assert.equal(
    SUPERVISION_NOTIFICATION_PUSH_EVENT,
    'b3.supervision.notification.changed',
  );
});

test('nvk watch remove compiles to the sole CAS update as retirement', () => {
  const [rule] = installedWatchRules({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
  });
  assert.ok(rule);
  const update = watchRemoveRetirement(rule);
  assert.equal(update.watchRuleId, rule.id);
  assert.equal(update.expectedRecordVersion, rule.recordVersion);
  assert.equal(update.replacement.status, 'retired');
  assert.equal('delete' in update, false);
});

test('the frozen CLI surface contains exactly the §17 supervision verbs', () => {
  assert.deepEqual(SUPERVISION_CLI_COMMANDS, [
    'nvk watch add',
    'nvk watch list',
    'nvk watch update',
    'nvk watch remove',
    'nvk watch notifications',
    'nvk watch acknowledge',
    'nvk watch reset-drift',
  ]);
});

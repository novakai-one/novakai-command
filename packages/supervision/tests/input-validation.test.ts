import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCheckRunDriftInput,
  parseEvaluateSupervisionEventInput,
  parseInstallRunWatchersInput,
  parseNotificationFilter,
  parseRecordDriftStatusSubmissionInput,
} from '../contract/index.js';

test('installRunWatchers boundary validates both Run and launch-plan identities', () => {
  const parsed = parseInstallRunWatchersInput({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [
      { id: 'template.drift', version: 1, digest: 'sha256:drift-v1' },
    ],
    recipient: { kind: 'human', principalId: 'person_chris' },
    activityGeneration: 4,
    requestProvenance: {
      requestedBy: 'person_chris',
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174000',
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000',
    },
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.recipient, { kind: 'human', principalId: 'person_chris' });
  assert.equal(parsed.value.activityGeneration, 4);

  const crossed = parseInstallRunWatchersInput({
    agentRunId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [],
  });
  assert.equal(crossed.ok, false);
});

test('Runtime drift submission boundary carries the complete owner/CAS tuple', () => {
  const parsed = parseRecordDriftStatusSubmissionInput({
    watchDeadlineId: `watchDeadline_${'a'.repeat(52)}`,
    expectedRecordVersion: 4,
    expectedEpisodeId: `driftEpisode_${'b'.repeat(52)}`,
    expectedEffectKey: 'b3v4:notification-delivery:notification:test',
    expectedNotificationId: `notification_${'c'.repeat(52)}`,
    expectedNotificationInputReservationId: `notificationInput_${'d'.repeat(52)}`,
    expectedTerminalInputAttemptId: 'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ab',
    submission: {
      state: 'submitted-unconfirmed',
      submittedAt: '2026-08-03T00:00:00.000Z',
    },
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
});

test('installRunWatchers refuses an implicit recipient or activity generation', () => {
  const missing = parseInstallRunWatchersInput({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [],
  });
  assert.equal(missing.ok, false,
    'install accepted host-defaulted recipient/activity generation');
});

test('one install cannot ambiguously repeat a template id at another version', () => {
  const refused = parseInstallRunWatchersInput({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [
      { id: 'watch-template/idle', version: 1, digest: 'a'.repeat(64) },
      { id: 'watch-template/idle', version: 2, digest: 'b'.repeat(64) },
    ],
    recipient: { kind: 'human', principalId: 'person_chris' },
    activityGeneration: 1,
    requestProvenance: {
      requestedBy: 'person_chris',
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174000',
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000',
    },
  });
  assert.equal(refused.ok, false);
});

test('evaluateEvent boundary validates the complete committed event envelope', () => {
  const parsed = parseEvaluateSupervisionEventInput({
    event: {
      eventId: 'event-1',
      kind: 'agent.run.activity.changed',
      schemaVersion: 1,
      occurredAt: '2026-08-02T00:00:00.000Z',
      committedAt: '2026-08-02T00:00:00.001Z',
      sourceOwner: 'agent-runtime',
      traceId: 'trace_123e4567-e89b-42d3-a456-426614174000',
      cursor: 'cursor_activity-1',
      payload: { activityGeneration: 4 },
    },
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
});

test('notification filter parser preserves a declared recipient', () => {
  const parsed = parseNotificationFilter({
    recipient: {
      kind: 'agent',
      agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
    },
    limit: 20,
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.recipient, {
    kind: 'agent',
    agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
  });
});

test('drift-check boundary requires every exact generation/version fence', () => {
  const parsed = parseCheckRunDriftInput({
    watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    expectedActivityGeneration: 7,
    dueDeadlineId: `watchDeadline_${'a'.repeat(52)}`,
    expectedDeadlineRecordVersion: 4,
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseCheckRunDriftInput,
  parseEvaluateSupervisionEventInput,
  parseInstallRunWatchersInput,
  parseNotificationFilter,
} from '../contract/index.js';

test('installRunWatchers boundary validates both Run and launch-plan identities', () => {
  const parsed = parseInstallRunWatchersInput({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [
      { id: 'template.drift', version: 1, digest: 'sha256:drift-v1' },
    ],
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);

  const crossed = parseInstallRunWatchersInput({
    agentRunId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab',
    launchPlanId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    requiredTemplateRefs: [],
  });
  assert.equal(crossed.ok, false);
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

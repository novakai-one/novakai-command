import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgentUsageSummary,
  parseDriftCheckOutcome,
  parseWatchDeadline,
  parseWatchRule,
} from '../contract/index.js';
import { installedWatchRules } from './fixtures.js';

const RUN_ID = 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab';

test('public WatchRule and WatchDeadline records cross runtime validation', () => {
  const [rule] = installedWatchRules({
    agentRunId: RUN_ID as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
  });
  assert.equal(parseWatchRule(rule).ok, true);

  const deadline = {
    id: `watchDeadline_${'a'.repeat(52)}`,
    kind: 'watchDeadline',
    schemaVersion: 1,
    recordVersion: 2,
    createdAt: '2026-08-02T00:00:00.000Z',
    permissionLevel: 'team',
    createdBy: 'sys_supervision',
    lastMutation: { state: 'legacy-no-trace' },
    watchRuleId: rule?.id,
    subjectKey: RUN_ID,
    activityGeneration: 3,
    dueAt: '2026-08-02T00:10:00.000Z',
    state: 'armed',
  };
  assert.equal(parseWatchDeadline(deadline).ok, true);
  assert.equal(parseWatchDeadline(deadline, { conditionKind: 'activity-drift' }).ok, false);
});

test('durable drift validation rejects a queued request with a reply deadline', () => {
  const invalid = {
    id: `watchDeadline_${'a'.repeat(52)}`,
    kind: 'watchDeadline',
    schemaVersion: 1,
    recordVersion: 2,
    createdAt: '2026-08-02T00:00:00.000Z',
    permissionLevel: 'team',
    createdBy: 'sys_supervision',
    lastMutation: { state: 'legacy-no-trace' },
    watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    subjectKey: RUN_ID,
    activityGeneration: 3,
    dueAt: '2026-08-02T00:10:00.000Z',
    state: 'armed',
    driftState: {
      kind: 'activity-drift',
      episodeOrdinal: 1,
      phase: 'status-outstanding',
      quietIntervals: 2,
      episodeId: `driftEpisode_${'b'.repeat(52)}`,
      consecutiveUnansweredChecks: 0,
      outstandingStatus: {
        episodeId: `driftEpisode_${'b'.repeat(52)}`,
        effectKey: 'status:1',
        notificationId: `notification_${'c'.repeat(52)}`,
        state: 'queued',
        requestedAt: '2026-08-02T00:10:00.000Z',
        replyDueAt: '2026-08-02T00:15:00.000Z',
      },
    },
  };
  assert.equal(parseWatchDeadline(invalid).ok, false);
});

test('DriftCheckOutcome and AgentUsageSummary outputs reject contradictory shapes', () => {
  assert.equal(parseDriftCheckOutcome({
    kind: 'first-quiet-interval',
    providerTurnsStartedThisEvaluation: 1,
    staleIntervals: 1,
  }).ok, false);
  assert.equal(parseDriftCheckOutcome({
    kind: 'healthy-free-evidence',
    providerTurnsStartedThisEvaluation: 0,
    evidenceRefs: [42, null],
  }).ok, false);

  const measured = {
    quality: 'measured', value: 7, source: 'provider', limitations: [],
  };
  const run = {
    agentRunId: RUN_ID,
    inputTokens: measured,
    outputTokens: measured,
    cachedInputTokens: measured,
    costMicros: measured,
    providerTurns: measured,
    observedAt: '2026-08-02T00:00:00.000Z',
    final: true,
  };
  assert.equal(parseAgentUsageSummary({
    agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
    runs: [run],
    aggregate: {
      inputTokens: { ...measured, source: 'aggregate:runs' },
      outputTokens: { ...measured, source: 'aggregate:runs' },
      cachedInputTokens: { ...measured, source: 'aggregate:runs' },
      costMicros: { ...measured, source: 'aggregate:runs' },
      providerTurns: { ...measured, source: 'aggregate:runs' },
      observedAt: run.observedAt,
      final: true,
    },
  }).ok, true);

  const emptyMetric = {
    quality: 'unavailable', source: 'aggregate:runs', limitations: ['no-runs'],
  };
  const emptySummary = {
    agentId: 'agent_123e4567-e89b-42d3-a456-426614174000',
    runs: [],
    aggregate: {
      inputTokens: emptyMetric,
      outputTokens: emptyMetric,
      cachedInputTokens: emptyMetric,
      costMicros: emptyMetric,
      providerTurns: emptyMetric,
      observedAt: '2026-08-02T00:01:00.000Z',
      final: true,
    },
  };
  assert.equal(parseAgentUsageSummary(emptySummary).ok, true);
  assert.equal(parseAgentUsageSummary({
    ...emptySummary,
    aggregate: { ...emptySummary.aggregate, agentRunId: RUN_ID },
  }).ok, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveClientOpId } from '@novakai/foundation/contract';
import {
  parseAgentUsageSummary,
  parseDriftCheckOutcome,
  parseNotificationRecord,
  parseWatchDeadline,
  parseWatchRule,
} from '../contract/index.js';
import { installedWatchRules, queuedNotificationEvent } from './fixtures.js';

const RUN_ID = 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab';

test('records accept the ratified name-derived ClientOpId provenance', () => {
  const lastMutation = {
    state: 'trace-complete' as const,
    serverOpId: 'srv_123e4567-e89b-42d3-a456-426614174000',
    clientOpId: deriveClientOpId('b3d-freeze-defect-1'),
    traceId: 'trace_123e4567-e89b-42d3-a456-426614174000',
    committedAt: '2026-08-03T00:00:00.000Z',
  };
  const [baseRule] = installedWatchRules({
    agentRunId: RUN_ID as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    activityGeneration: 1 as never,
  });
  const rule = { ...baseRule, lastMutation };
  const deadline = {
    id: `watchDeadline_${'a'.repeat(52)}`,
    kind: 'watchDeadline',
    schemaVersion: 1,
    recordVersion: 2,
    createdAt: '2026-08-03T00:00:00.000Z',
    permissionLevel: 'team',
    createdBy: 'sys_supervision',
    lastMutation,
    watchRuleId: rule.id,
    subjectKey: RUN_ID,
    activityGeneration: 3,
    dueAt: '2026-08-03T00:10:00.000Z',
    state: 'armed',
  };
  const notification = {
    ...queuedNotificationEvent('queue-only').payload,
    lastMutation,
  };

  assert.equal(parseWatchRule(rule).ok, true, 'WatchRule refused derived ClientOpId');
  assert.equal(parseWatchDeadline(deadline).ok, true, 'WatchDeadline refused derived ClientOpId');
  assert.equal(parseNotificationRecord(notification).ok, true,
    'Notification refused derived ClientOpId');
  assert.equal(parseWatchRule({
    ...rule,
    lastMutation: {
      ...lastMutation,
      clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000',
    },
  }).ok, true, 'WatchRule refused caller-minted ClientOpId');
  assert.equal(parseWatchRule({
    ...rule,
    lastMutation: {
      ...lastMutation,
      clientOpId: 'op_123e4567-e89b-72d3-a456-426614174000',
    },
  }).ok, false, 'WatchRule accepted a UUID version outside the §3.2 forms');
  assert.equal(parseWatchRule({
    ...rule,
    lastMutation: {
      ...lastMutation,
      clientOpId: 'op_123e4567-e89b-52d3-7456-426614174000',
    },
  }).ok, false, 'WatchRule accepted a UUID with a non-RFC variant');
});

test('public WatchRule and WatchDeadline records cross runtime validation', () => {
  const [rule] = installedWatchRules({
    agentRunId: RUN_ID as never,
    launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    requiredTemplateRefs: [],
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    activityGeneration: 1 as never,
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

test('AMD-003 #23: legacy and occurrence-aware Notifications round-trip only lawful shapes', () => {
  const legacy = queuedNotificationEvent('queue-only').payload;
  const legacyJson = JSON.stringify(legacy);
  const parsedLegacy = parseNotificationRecord(JSON.parse(legacyJson));
  assert.equal(parsedLegacy.ok, true, parsedLegacy.ok ? '' : parsedLegacy.error.message);
  if (!parsedLegacy.ok) return;
  assert.equal(JSON.stringify(parsedLegacy.value), legacyJson);
  assert.equal(parseNotificationRecord({
    ...legacy,
    qualifiedAt: '2026-08-02T00:01:00.000Z',
  }).ok, false, 'schema version 1 accepted occurrence time');

  const commonOccurrence = {
    agentRunId: RUN_ID,
    providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174000',
    qualifyingEvidenceRef: `providerUsage_${'a'.repeat(52)}`,
    qualifiedAt: '2026-08-02T00:01:00.000Z',
  };
  const variants = [
    {
      occurrenceIdentity: 'agent-run',
      conditionOccurrence: { ...commonOccurrence, kind: 'agent-run' },
    },
    {
      occurrenceIdentity: 'committed-event',
      conditionOccurrence: {
        ...commonOccurrence, kind: 'committed-event', eventId: 'event_usage-100k-1',
      },
    },
    {
      occurrenceIdentity: 'run-operation',
      conditionOccurrence: {
        ...commonOccurrence,
        kind: 'run-operation',
        runOperationId: `runOperation_${'b'.repeat(52)}`,
      },
    },
  ] as const;
  for (const variant of variants) {
    const parsed = parseNotificationRecord({
      ...legacy,
      schemaVersion: 2,
      qualifiedAt: commonOccurrence.qualifiedAt,
      ...variant,
    });
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  }

  assert.equal(parseNotificationRecord({
    ...legacy,
    schemaVersion: 2,
    occurrenceIdentity: 'legacy-generation',
    qualifiedAt: commonOccurrence.qualifiedAt,
    conditionOccurrence: { ...commonOccurrence, kind: 'agent-run' },
  }).ok, false, 'legacy-generation accepted typed occurrence provenance');
  assert.equal(parseNotificationRecord({
    ...legacy,
    schemaVersion: 2,
    occurrenceIdentity: 'agent-run',
    conditionOccurrence: { ...commonOccurrence, kind: 'agent-run' },
  }).ok, false, 'schema version 2 accepted absent qualifiedAt');
  assert.equal(parseNotificationRecord({
    ...legacy,
    schemaVersion: 2,
    occurrenceIdentity: 'committed-event',
    qualifiedAt: commonOccurrence.qualifiedAt,
    conditionOccurrence: { ...commonOccurrence, kind: 'committed-event' },
  }).ok, false, 'committed-event provenance accepted an absent eventId');
  assert.equal(parseNotificationRecord({
    ...legacy,
    schemaVersion: 2,
    occurrenceIdentity: 'run-operation',
    qualifiedAt: commonOccurrence.qualifiedAt,
    conditionOccurrence: {
      ...commonOccurrence, kind: 'run-operation',
      runOperationId: `watchEvaluation_${'c'.repeat(52)}`,
    },
  }).ok, false, 'operation provenance accepted a wrong identity prefix');
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

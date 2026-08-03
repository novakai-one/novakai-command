import test from 'node:test';
import assert from 'node:assert/strict';
import { b3ok } from '@novakai/foundation/contract';
import {
  createUsageProjection,
  type UsageEvidenceReader,
  type UsageRunFacts,
  type UsageRunReader,
} from '../core/index.js';
import type { ProviderUsageEvidence } from '../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never;
const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as never;
const SECOND_RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a2' as never;
const SECOND_SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174001' as never;
const PRINCIPAL = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };

const run = {
  agentRunId: RUN_ID,
  agentId: AGENT_ID,
  providerSessionId: SESSION_ID,
  final: false,
};

function runReader(): UsageRunReader {
  return {
    getUsageRun: async () => b3ok(run),
    listUsageRuns: async () => b3ok([run]),
  };
}

function noEvidence(): UsageEvidenceReader {
  return {
    listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
  };
}

const MEASURED_EVIDENCE: ProviderUsageEvidence = {
  id: `providerUsage_${'a'.repeat(52)}` as never,
  kind: 'providerUsageEvidence',
  schemaVersion: 1,
  recordVersion: 1 as never,
  createdAt: '2026-08-03T02:01:00.000Z' as never,
  permissionLevel: 'private',
  createdBy: 'sys_agents',
  lastMutation: { state: 'legacy-no-trace' },
  providerSessionId: SESSION_ID,
  providerConversationId: 'provider-conversation-1',
  observedAt: '2026-08-03T02:01:00.000Z' as never,
  source: 'provider-turn-completed',
  sourceCursor: 'turn-1',
  measurement: {
    quality: 'measured',
    inputTokens: 125,
    outputTokens: 25,
    cachedInputTokens: 10,
    costMicros: 42_000,
    providerTurns: 1,
    limitations: [],
    evidenceDigest: 'sha256:provider-turn-1',
  },
};

const TURN_A = 'providerTurn_019fd000-0000-7000-8000-0000000000b1' as never;
const TURN_B = 'providerTurn_019fd000-0000-7000-8000-0000000000b2' as never;

function turnEvidence(turn: typeof TURN_A, suffix: string): ProviderUsageEvidence {
  return {
    ...MEASURED_EVIDENCE,
    id: `providerUsage_${suffix.repeat(52)}` as never,
    scope: {
      kind: 'runtime-turn-completion', agentRunId: RUN_ID, providerTurnId: turn,
      transcriptTurnCompletionId: `transcriptTurnCompletion_${suffix.repeat(52)}` as never,
    },
    source: 'transcript-turn-completion',
    measurement: {
      quality: 'partial', providerTurns: 1,
      limitations: [
        'provider turn completion is measured; per-turn token and cost attribution is unavailable',
      ],
      evidenceDigest: `sha256:turn-${suffix}`,
    },
  };
}

test('every known Run has a complete unavailable usage row before evidence arrives', async () => {
  const usage = createUsageProjection({
    runs: runReader(),
    evidence: noEvidence(),
    clock: () => new Date('2026-08-03T02:00:00.000Z'),
  });

  const result = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.agentRunId, RUN_ID);
  assert.equal(result.value.observedAt, '2026-08-03T02:00:00.000Z');
  assert.equal(result.value.final, false);
  for (const metric of [
    result.value.inputTokens,
    result.value.outputTokens,
    result.value.cachedInputTokens,
    result.value.costMicros,
    result.value.providerTurns,
  ]) {
    assert.equal(metric.quality, 'unavailable');
    assert.equal('value' in metric, false);
    assert.notEqual(metric.source, '');
    assert.ok(metric.limitations.includes('no-provider-usage-evidence'));
  }
});

test('one committed provider measurement moves the live Run projection', async () => {
  const usage = createUsageProjection({
    runs: runReader(),
    evidence: {
      listProviderUsageEvidence: async () => b3ok({
        items: [MEASURED_EVIDENCE],
        omissions: [],
      }),
    },
  });

  const result = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.observedAt, MEASURED_EVIDENCE.observedAt);
  assert.deepEqual(result.value.inputTokens, {
    quality: 'measured',
    value: 125,
    source: 'provider-turn-completed',
    limitations: [],
  });
  assert.equal(result.value.outputTokens.value, 25);
  assert.equal(result.value.cachedInputTokens.value, 10);
  assert.equal(result.value.costMicros.value, 42_000);
  assert.equal(result.value.providerTurns.value, 1);
});

test('enumerable submissions count only exact canonical completion rows', async () => {
  const usage = createUsageProjection({
    runs: {
      getUsageRun: async () => b3ok({
        ...run,
        providerTurnSubmissions: [
          { providerTurnId: TURN_A, state: 'completed' as const },
          { providerTurnId: TURN_B, state: 'submitted-confirmed' as const },
          {
            providerTurnId: 'providerTurn_019fd000-0000-7000-8000-0000000000b3' as never,
            state: 'queued' as const,
          },
        ],
      }),
      listUsageRuns: async () => b3ok([]),
    },
    evidence: {
      listProviderUsageEvidence: async () => b3ok({
        items: [turnEvidence(TURN_A, 'b')], omissions: [],
      }),
    },
  });
  const result = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(result.value.providerTurns, {
    quality: 'partial', value: 1, source: 'runtime:provider-turn-submissions',
    limitations: ['in-flight-provider-turn-completion-evidence-pending'],
  });
});

test('full canonical coverage is measured while recovery and cumulative overlap stay partial', async () => {
  const states = [
    { providerTurnId: TURN_A, state: 'completed' as const },
    { providerTurnId: TURN_B, state: 'submitted-unconfirmed' as const },
  ];
  let providerTurnSubmissions: NonNullable<UsageRunFacts['providerTurnSubmissions']> = states;
  let items: ProviderUsageEvidence[] = [turnEvidence(TURN_A, 'b'), turnEvidence(TURN_B, 'c')];
  const usage = createUsageProjection({
    runs: {
      getUsageRun: async () => b3ok({ ...run, providerTurnSubmissions }),
      listUsageRuns: async () => b3ok([]),
    },
    evidence: { listProviderUsageEvidence: async () => b3ok({ items, omissions: [] }) },
  });

  const measured = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(measured.ok, true);
  if (measured.ok) assert.deepEqual(measured.value.providerTurns, {
    quality: 'measured', value: 2, source: 'runtime:provider-turn-submissions', limitations: [],
  });

  items = [...items, MEASURED_EVIDENCE];
  const overlap = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(overlap.ok, true);
  if (overlap.ok) assert.deepEqual(overlap.value.providerTurns, {
    quality: 'partial', value: 2, source: 'runtime:provider-turn-submissions',
    limitations: ['cumulative-provider-turn-overlap-unproven'],
  });

  providerTurnSubmissions = [
    ...states,
    {
      providerTurnId: 'providerTurn_019fd000-0000-7000-8000-0000000000b4' as never,
      state: 'completion-unproven-final' as const,
    },
  ];
  items = items.slice(0, 2);
  const unproven = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(unproven.ok, true);
  if (unproven.ok) assert.deepEqual(unproven.value.providerTurns, {
    quality: 'partial', value: 2, source: 'runtime:provider-turn-submissions',
    limitations: ['provider-turn-completion-unproven'],
  });
});

test('sourced transcript totals fill token usage when Agents has no provider measurement', async () => {
  const usage = createUsageProjection({
    runs: runReader(),
    evidence: noEvidence(),
    transcript: {
      readTranscriptUsage: async () => b3ok({
        quality: 'estimated',
        inputTokens: 240,
        outputTokens: 60,
        cachedInputTokens: 20,
        observedAt: '2026-08-03T02:04:00.000Z' as never,
        source: 'transcript:claude/session.jsonl',
        limitations: ['provider transcript totals are an estimate'],
      }),
    },
  });

  const result = await usage.getRunUsage(PRINCIPAL, RUN_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(result.value.inputTokens, {
    quality: 'estimated',
    value: 240,
    source: 'transcript:claude/session.jsonl',
    limitations: ['provider transcript totals are an estimate'],
  });
  assert.equal(result.value.outputTokens.value, 60);
  assert.equal(result.value.cachedInputTokens.value, 20);
  assert.equal(result.value.costMicros.quality, 'unavailable');
  assert.equal(result.value.costMicros.value, undefined);
  assert.ok(result.value.costMicros.limitations.includes('costMicros-not-reported'));
  assert.equal(result.value.providerTurns.quality, 'unavailable');
  assert.equal(result.value.providerTurns.value, undefined);
  assert.equal(result.value.observedAt, '2026-08-03T02:04:00.000Z');
});

test('Agent aggregate is no more certain than its least certain Run', async () => {
  const secondRun = {
    agentRunId: SECOND_RUN_ID,
    agentId: AGENT_ID,
    providerSessionId: SECOND_SESSION_ID,
    final: true,
  };
  const usage = createUsageProjection({
    runs: {
      getUsageRun: async (_principal, agentRunId) => b3ok(
        agentRunId === RUN_ID ? run : secondRun,
      ),
      listUsageRuns: async () => b3ok([secondRun, run]),
    },
    evidence: {
      listProviderUsageEvidence: async (_principal, providerSessionId) => b3ok({
        items: providerSessionId === SESSION_ID ? [MEASURED_EVIDENCE] : [],
        omissions: [],
      }),
    },
    clock: () => new Date('2026-08-03T02:02:00.000Z'),
  });

  const result = await usage.getAgentUsage(PRINCIPAL, AGENT_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(result.value.runs.map((item) => item.agentRunId), [
    RUN_ID,
    SECOND_RUN_ID,
  ]);
  assert.deepEqual(result.value.aggregate.inputTokens, {
    quality: 'partial',
    value: 125,
    source: 'aggregate:runs',
    limitations: [String(SECOND_RUN_ID), 'no-provider-usage-evidence'],
  });
  assert.equal(result.value.aggregate.outputTokens.quality, 'partial');
  assert.equal(result.value.aggregate.final, false);
  assert.equal(result.value.aggregate.observedAt, '2026-08-03T02:02:00.000Z');
});

test('aggregate quality follows the exact measured, estimated, partial, unavailable table', async () => {
  const {
    outputTokens: omittedOutputTokens,
    ...measurementWithoutOutputTokens
  } = MEASURED_EVIDENCE.measurement;
  void omittedOutputTokens;
  const estimated = {
    ...MEASURED_EVIDENCE,
    id: `providerUsage_${'b'.repeat(52)}` as never,
    providerSessionId: SECOND_SESSION_ID,
    observedAt: '2026-08-03T02:02:00.000Z' as never,
    measurement: {
      ...measurementWithoutOutputTokens,
      quality: 'estimated' as const,
      limitations: ['provider-omitted-output'],
    },
  };
  const secondRun = {
    agentRunId: SECOND_RUN_ID,
    agentId: AGENT_ID,
    providerSessionId: SECOND_SESSION_ID,
    final: true,
  };
  const usage = createUsageProjection({
    runs: {
      getUsageRun: async () => b3ok(run),
      listUsageRuns: async () => b3ok([run, secondRun]),
    },
    evidence: {
      listProviderUsageEvidence: async (_principal, providerSessionId) => b3ok({
        items: providerSessionId === SESSION_ID ? [MEASURED_EVIDENCE] : [estimated],
        omissions: [],
      }),
    },
  });

  const result = await usage.getAgentUsage(PRINCIPAL, AGENT_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.aggregate.inputTokens.quality, 'estimated');
  assert.equal(result.value.aggregate.inputTokens.value, 250);
  assert.equal(result.value.aggregate.outputTokens.quality, 'partial');
  assert.equal(result.value.aggregate.outputTokens.value, 25);
  assert.deepEqual(result.value.aggregate.outputTokens.limitations, [
    String(SECOND_RUN_ID),
    'outputTokens-not-reported',
    'provider-omitted-output',
  ]);
});

test('an Agent with no Runs gets explicit unavailable no-runs values', async () => {
  const usage = createUsageProjection({
    runs: {
      getUsageRun: async () => b3ok(run),
      listUsageRuns: async () => b3ok([]),
    },
    evidence: noEvidence(),
    clock: () => new Date('2026-08-03T02:03:00.000Z'),
  });

  const result = await usage.getAgentUsage(PRINCIPAL, AGENT_ID);
  assert.equal(result.ok, true, result.ok ? '' : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(result.value.runs, []);
  assert.deepEqual(result.value.aggregate.costMicros, {
    quality: 'unavailable',
    source: 'aggregate:runs',
    limitations: ['no-runs'],
  });
  assert.equal(result.value.aggregate.observedAt, '2026-08-03T02:03:00.000Z');
  assert.equal(result.value.aggregate.final, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3ok, canonicalRequestHash, mintClientOpId, mintTraceCorrelationId,
  type B3Result, type IsoUtc, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  composeSupervision, createSupervisionStore,
  type SupervisionCore, type SupervisionCoreOptions, type UsageRunReader,
} from '../core/index.js';
import {
  deriveNotificationId, subjectKey, type ProviderUsageEvidence, type RunOccurrenceEventFacts,
  type WatchCondition,
} from '../contract/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never;
const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as never;
const GENERATION = 4 as never;
const HUMAN = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };
const ownedEvidence = new Map<string, ProviderUsageEvidence>();

const usageContext = (): SystemCommandContext<'sys_agents'> => ({
  principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function unwrap<Value>(result: B3Result<Value>, what: string): Value {
  if (!result.ok) throw new Error(`${what}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

function options(
  root: string,
  occurrenceEvents = new Map<string, RunOccurrenceEventFacts>(),
): SupervisionCoreOptions {
  const run = {
    agentRunId: RUN_ID,
    agentId: AGENT_ID,
    providerSessionId: SESSION_ID,
    lifecycle: 'ready' as const,
    final: false,
    activityGeneration: GENERATION,
    recordVersion: 1 as never,
  };
  const runs: UsageRunReader = {
    getUsageRun: async () => b3ok(run),
    listUsageRuns: async () => b3ok([run]),
    resolveUsageRunByProviderSession: async () => b3ok(run),
    resolveCurrentRunByAgent: async () => b3ok(run),
    getRunOccurrenceEvent: async (_principal, eventId) =>
      b3ok(occurrenceEvents.get(eventId) ?? null),
  };
  return {
    root,
    dataRoot: path.join(root, 'stores'),
    installAuthority: { resolve: async () => { throw new Error('not used'); } },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    watchRuleGeneration: { generationFor: async () => b3ok(GENERATION) },
    usage: {
      runs,
      evidence: {
        getProviderUsageEvidence: async (_principal, id) => b3ok(
          ownedEvidence.get(String(id)) ?? null,
        ),
        listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
      },
    },
  };
}

function runtimeUsageEvent(
  evidence: ReturnType<typeof usageEvidenceEvent>,
  occurrenceEvents: Map<string, RunOccurrenceEventFacts>,
  revision: number,
) {
  const eventId = `event_runtime_usage_${revision}`;
  const occurredAt = evidence.payload.observedAt as IsoUtc;
  const payload = {
    agentRunId: RUN_ID,
    providerSessionId: SESSION_ID,
    activityGeneration: Number(GENERATION),
    qualifyingEvidenceRef: evidence.payload.id,
  };
  const event = {
    eventId,
    kind: 'agent.run.usage.changed',
    schemaVersion: 1 as const,
    occurredAt,
    committedAt: evidence.committedAt,
    sourceOwner: 'agent-runtime' as const,
    traceId: evidence.traceId,
    cursor: `runtime-usage-${revision}` as never,
    payload,
  };
  occurrenceEvents.set(eventId, {
    eventId,
    kind: 'agent.run.usage.changed',
    occurrenceKind: 'usage-generation',
    occurredAt: event.occurredAt,
    committedAt: event.committedAt,
    sourceOwner: 'agent-runtime',
    agentRunId: RUN_ID,
    agentId: AGENT_ID,
    providerSessionId: SESSION_ID,
    lifecycle: 'ready',
    final: false,
    activityGeneration: GENERATION,
    canonicalPayloadDigest: canonicalRequestHash(payload),
    occurrence: { qualifyingEvidenceRef: evidence.payload.id as never },
  });
  return event;
}

async function createRule(supervision: SupervisionCore, condition: WatchCondition) {
  return unwrap(await supervision.createWatchRule({
    principal: HUMAN,
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  }, {
    subject: { kind: 'agent-run', agentRunId: RUN_ID },
    condition,
    recipient: { kind: 'human', principalId: HUMAN.id },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
  }), `create ${condition.kind} rule`);
}

test('usage threshold notification identity absorbs replay and restart redelivery', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-usage-threshold-replay-'));
  try {
    const occurrenceEvents = new Map<string, RunOccurrenceEventFacts>();
    const configured = options(root, occurrenceEvents);
    const firstStore = createSupervisionStore(configured);
    const supervision = composeSupervision({ ...configured, store: firstStore });
    const condition = { kind: 'output-tokens-at-least' as const, value: 100_000 };
    const rule = await createRule(supervision, condition);
    const measurement = {
      quality: 'measured' as const,
      inputTokens: 50_000,
      outputTokens: 100_000,
      cachedInputTokens: 10_000,
      costMicros: 2_500_000,
      providerTurns: 100,
      limitations: [],
      evidenceDigest: 'sha256:usage-100k',
    };
    const event = usageEvidenceEvent(measurement);
    ownedEvidence.set(
      String(event.payload.id), event.payload as unknown as ProviderUsageEvidence,
    );
    const sourceEvent = runtimeUsageEvent(event, occurrenceEvents, 1);

    const first = unwrap(
      await supervision.evaluateEvent(usageContext(), { event: sourceEvent }),
      'first threshold evaluation',
    );
    const replay = unwrap(
      await supervision.evaluateEvent(usageContext(), { event: sourceEvent }),
      'same-event replay',
    );
    assert.equal(first.length, 1);
    assert.deepEqual(replay, []);
    assert.equal(first[0]!.id, deriveNotificationId({
      watchRuleId: rule.id,
      subjectKey: subjectKey(rule.subject),
      condition,
      activityGeneration: GENERATION,
      phase: 'condition',
    }));
    assert.deepEqual(first[0]!.evidenceRefs, [sourceEvent.eventId]);

    const restarted = composeSupervision({
      ...configured,
      store: createSupervisionStore(configured),
    });
    const equivalentNewEvent = usageEvidenceEvent(measurement, 2);
    ownedEvidence.set(
      String(equivalentNewEvent.payload.id),
      equivalentNewEvent.payload as unknown as ProviderUsageEvidence,
    );
    const equivalentSource = runtimeUsageEvent(equivalentNewEvent, occurrenceEvents, 2);
    const redelivery = unwrap(
      await restarted.evaluateEvent(usageContext(), { event: equivalentSource }),
      'post-restart equivalent redelivery',
    );
    assert.deepEqual(redelivery, []);
    const stored = unwrap(
      await restarted.listNotifications(HUMAN, { limit: 50 }),
      'notifications after restart',
    );
    assert.equal(stored.items.length, 1);
    assert.equal(stored.items[0]!.id, first[0]!.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('usage threshold evaluation compares every at-least condition inclusively', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-usage-threshold-kinds-'));
  try {
    const occurrenceEvents = new Map<string, RunOccurrenceEventFacts>();
    const supervision = composeSupervision(options(root, occurrenceEvents));
    const satisfied = [
      { kind: 'turn-count-at-least' as const, value: 100 },
      { kind: 'input-tokens-at-least' as const, value: 50_000 },
      { kind: 'output-tokens-at-least' as const, value: 100_000 },
      { kind: 'cost-micros-at-least' as const, value: 2_500_000 },
    ];
    const expectedRuleIds = [];
    for (const condition of satisfied) {
      expectedRuleIds.push((await createRule(supervision, condition)).id);
    }
    const unsatisfied = await createRule(
      supervision,
      { kind: 'output-tokens-at-least', value: 100_001 },
    );
    const event = usageEvidenceEvent({
      quality: 'measured',
      inputTokens: 50_000,
      outputTokens: 100_000,
      cachedInputTokens: 10_000,
      costMicros: 2_500_000,
      providerTurns: 100,
      limitations: [],
      evidenceDigest: 'sha256:usage-all-thresholds',
    });
    ownedEvidence.set(
      String(event.payload.id), event.payload as unknown as ProviderUsageEvidence,
    );
    const sourceEvent = runtimeUsageEvent(event, occurrenceEvents, 3);

    const queued = unwrap(
      await supervision.evaluateEvent(usageContext(), { event: sourceEvent }),
      'all threshold evaluation',
    );
    assert.deepEqual(
      queued.map((notification) => notification.watchRuleId).sort(),
      expectedRuleIds.sort(),
    );
    assert.equal(
      queued.some((notification) => notification.watchRuleId === unsatisfied.id),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

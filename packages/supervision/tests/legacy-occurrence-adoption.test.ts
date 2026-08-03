import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, deriveClientOpId, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type ProviderSessionId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, notificationDeliveryEffectKey, subjectKey,
  SUPERVISION_RECORD_WRITER,
  type Notification, type ProviderUsageEvidence, type WatchCondition, type WatchRule,
} from '../contract/index.js';
import { composeSupervision, createSupervisionStore } from '../core/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const RUN_1 = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as AgentRunId;
const RUN_2 = 'agentRun_019fd000-0000-7000-8000-0000000000a2' as AgentRunId;
const SESSION_1 = 'sess_123e4567-e89b-42d3-a456-426614174001' as ProviderSessionId;
const SESSION_2 = 'sess_123e4567-e89b-42d3-a456-426614174002' as ProviderSessionId;
const HUMAN = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };
const CONDITION = { kind: 'output-tokens-at-least' as const, value: 1 };
const DIFFERENT_CONDITION = { kind: 'output-tokens-at-least' as const, value: 2 };

const context = (): SystemCommandContext<'sys_agents'> => ({
  principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function evidence(
  body: string,
  session: ProviderSessionId,
  observedAt: string,
): ReturnType<typeof usageEvidenceEvent> {
  const base = usageEvidenceEvent({
    quality: 'measured', inputTokens: 1, outputTokens: 2, cachedInputTokens: 0,
    costMicros: 1, providerTurns: 1, limitations: [], evidenceDigest: `sha256:${body}`,
  });
  return {
    ...base,
    eventId: `event_${body}`,
    occurredAt: observedAt as never,
    committedAt: observedAt as never,
    payload: {
      ...base.payload,
      id: `providerUsage_${body.repeat(52)}`,
      providerSessionId: session,
      observedAt,
      measurement: { ...base.payload['measurement'] as object, evidenceDigest: `sha256:${body}` },
    },
  } as ReturnType<typeof usageEvidenceEvent>;
}

async function seedLegacy(
  store: ReturnType<typeof createSupervisionStore>,
  rule: WatchRule,
  condition: WatchCondition,
  generation: number,
  evidenceRefs: readonly string[],
): Promise<Notification> {
  const id = deriveNotificationId({
    watchRuleId: rule.id,
    subjectKey: subjectKey(rule.subject),
    condition,
    activityGeneration: generation as never,
    phase: 'condition',
  });
  const effectKey = notificationDeliveryEffectKey(id);
  const written = await store.create<Notification>(SUPERVISION_RECORD_WRITER, {
    kind: 'notification', id, schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z' as never,
    permissionLevel: 'private', createdBy: SUPERVISION_RECORD_WRITER,
    deliveryEffectKey: effectKey,
    deliveryAttempt: { state: 'queued', effectKey },
    watchRuleId: rule.id,
    subject: rule.subject,
    recipient: rule.recipient,
    conditionGeneration: generation,
    summary: 'legacy usage threshold',
    evidenceRefs,
    state: 'queued',
    deliveryMode: rule.deliveryMode,
    phase: 'condition',
  }, deriveClientOpId(`test:legacy-notification:${String(id)}`));
  if (!written.ok) throw new Error(written.error.message);
  assert.equal(written.ok, true);
  return written.value;
}

test('legacy adoption implements all four occurrence/condition decisions after generation advance', async () => {
  const scenarios = [
    { name: 'same occurrence, same condition', legacyRun: RUN_1, candidateRun: RUN_1,
      legacyCondition: CONDITION, adopted: true },
    { name: 'same occurrence, different condition', legacyRun: RUN_1, candidateRun: RUN_1,
      legacyCondition: DIFFERENT_CONDITION, adopted: false },
    { name: 'different occurrence, same condition', legacyRun: RUN_1, candidateRun: RUN_2,
      legacyCondition: CONDITION, adopted: false },
    { name: 'different occurrence, different condition', legacyRun: RUN_1, candidateRun: RUN_2,
      legacyCondition: DIFFERENT_CONDITION, adopted: false },
  ] as const;

  for (const scenario of scenarios) {
    const root = mkdtempSync(path.join(tmpdir(), 'nvk-legacy-four-way-'));
    try {
      const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
      const legacyEvidence = evidence('a', SESSION_1, '2026-08-04T00:00:01.000Z');
      const currentEvidence = evidence(
        scenario.candidateRun === RUN_1 ? 'c' : 'd',
        scenario.candidateRun === RUN_1 ? SESSION_1 : SESSION_2,
        '2026-08-04T00:00:02.000Z',
      );
      const evidenceById = new Map<string, ProviderUsageEvidence>([
        [String(legacyEvidence.payload.id), legacyEvidence.payload as unknown as ProviderUsageEvidence],
        [String(currentEvidence.payload.id), currentEvidence.payload as unknown as ProviderUsageEvidence],
      ]);
      const runBySession = new Map<ProviderSessionId, {
        agentRunId: AgentRunId; agentId: typeof AGENT_ID; providerSessionId: ProviderSessionId;
        lifecycle: 'ready'; final: false; activityGeneration: never; recordVersion: never;
      }>([
        [SESSION_1, { agentRunId: RUN_1, agentId: AGENT_ID, providerSessionId: SESSION_1,
          lifecycle: 'ready', final: false, activityGeneration: 99 as never, recordVersion: 7 as never }],
        [SESSION_2, { agentRunId: RUN_2, agentId: AGENT_ID, providerSessionId: SESSION_2,
          lifecycle: 'ready', final: false, activityGeneration: 99 as never, recordVersion: 7 as never }],
      ]);
      const supervision = composeSupervision({
        root, dataRoot: path.join(root, 'stores'), store,
        installAuthority: { resolve: async () => { throw new Error('not used'); } },
        watchRuleAccess: { agentIdFor: async () => b3ok(null) },
        watchRuleGeneration: { generationFor: async () => b3ok(99 as never) },
        usage: {
          runs: {
            getUsageRun: async (_principal, runId) => b3ok(
              [...runBySession.values()].find((run) => run.agentRunId === runId)!,
            ),
            listUsageRuns: async () => b3ok([...runBySession.values()]),
            resolveUsageRunByProviderSession: async (_principal, session) =>
              b3ok(runBySession.get(session) ?? null),
            resolveCurrentRunByAgent: async () => b3ok(null),
            getRunOccurrenceEvent: async () => b3ok(null),
          },
          evidence: {
            getProviderUsageEvidence: async (_principal, id) =>
              b3ok(evidenceById.get(String(id)) ?? null),
            listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
          },
        },
      });
      const created = await supervision.createWatchRule({
        principal: HUMAN, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(),
        contractVersion: 1,
      }, {
        subject: { kind: 'agent', agentId: AGENT_ID },
        condition: CONDITION,
        recipient: { kind: 'human', principalId: HUMAN.id },
        deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
      });
      assert.equal(created.ok, true, scenario.name);
      if (!created.ok) continue;
      const legacy = await seedLegacy(
        store, created.value, scenario.legacyCondition, 1,
        [String(legacyEvidence.payload.id)],
      );

      const evaluated = await supervision.evaluateEvent(context(), { event: currentEvidence });
      assert.equal(evaluated.ok, true, scenario.name);
      if (!evaluated.ok) continue;
      assert.equal(evaluated.value.length, scenario.adopted ? 0 : 1, scenario.name);
      const stored = await supervision.listNotifications(HUMAN, { limit: 20 });
      assert.equal(stored.ok, true);
      if (!stored.ok) continue;
      assert.equal(stored.value.items.length, scenario.adopted ? 1 : 2, scenario.name);
      const unchanged = stored.value.items.find((item) => item.id === legacy.id)!;
      assert.equal(unchanged.schemaVersion, 1);
      assert.equal(unchanged.recordVersion, legacy.recordVersion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('many legacy generations for one Run adopt without rewriting history', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-legacy-many-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const first = evidence('a', SESSION_1, '2026-08-04T00:00:01.000Z');
    const second = evidence('c', SESSION_1, '2026-08-04T00:00:02.000Z');
    const current = evidence('d', SESSION_1, '2026-08-04T00:00:03.000Z');
    const evidenceById = new Map([first, second, current].map((event) => [
      String(event.payload.id), event.payload as unknown as ProviderUsageEvidence,
    ]));
    const run = { agentRunId: RUN_1, agentId: AGENT_ID, providerSessionId: SESSION_1,
      lifecycle: 'ready' as const, final: false, activityGeneration: 99 as never,
      recordVersion: 7 as never };
    const supervision = composeSupervision({
      root, dataRoot: path.join(root, 'stores'), store,
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(99 as never) },
      usage: {
        runs: {
          getUsageRun: async () => b3ok(run), listUsageRuns: async () => b3ok([run]),
          resolveUsageRunByProviderSession: async () => b3ok(run),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async () => b3ok(null),
        },
        evidence: {
          getProviderUsageEvidence: async (_principal, id) =>
            b3ok(evidenceById.get(String(id)) ?? null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const created = await supervision.createWatchRule({
      principal: HUMAN, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      subject: { kind: 'agent', agentId: AGENT_ID }, condition: CONDITION,
      recipient: { kind: 'human', principalId: HUMAN.id }, deliveryMode: 'queue-only',
      cooldownMs: 0, status: 'active',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const legacy1 = await seedLegacy(store, created.value, CONDITION, 1, [String(first.payload.id)]);
    const legacy2 = await seedLegacy(store, created.value, CONDITION, 2, [String(second.payload.id)]);
    const evaluated = await supervision.evaluateEvent(context(), { event: current });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok) return;
    assert.deepEqual(evaluated.value, []);
    const stored = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    assert.deepEqual(stored.value.items.map((item) => item.id).sort(), [legacy1.id, legacy2.id].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('contradictory legacy evidence fails closed and stays operator-visible', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-legacy-ambiguous-'));
  try {
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    const one = evidence('a', SESSION_1, '2026-08-04T00:00:01.000Z');
    const two = evidence('c', SESSION_2, '2026-08-04T00:00:01.000Z');
    const evidenceById = new Map([one, two].map((event) => [
      String(event.payload.id), event.payload as unknown as ProviderUsageEvidence,
    ]));
    const runs = new Map([
      [SESSION_1, { agentRunId: RUN_1, agentId: AGENT_ID, providerSessionId: SESSION_1,
        lifecycle: 'ready' as const, final: false, activityGeneration: 99 as never,
        recordVersion: 1 as never }],
      [SESSION_2, { agentRunId: RUN_2, agentId: AGENT_ID, providerSessionId: SESSION_2,
        lifecycle: 'ready' as const, final: false, activityGeneration: 99 as never,
        recordVersion: 1 as never }],
    ]);
    const supervision = composeSupervision({
      root, dataRoot: path.join(root, 'stores'), store,
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(99 as never) },
      usage: {
        runs: {
          getUsageRun: async () => b3ok(runs.get(SESSION_1)!),
          listUsageRuns: async () => b3ok([...runs.values()]),
          resolveUsageRunByProviderSession: async (_principal, session) =>
            b3ok(runs.get(session) ?? null),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async () => b3ok(null),
        },
        evidence: {
          getProviderUsageEvidence: async (_principal, id) =>
            b3ok(evidenceById.get(String(id)) ?? null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const created = await supervision.createWatchRule({
      principal: HUMAN, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      subject: { kind: 'agent', agentId: AGENT_ID }, condition: CONDITION,
      recipient: { kind: 'human', principalId: HUMAN.id }, deliveryMode: 'queue-only',
      cooldownMs: 0, status: 'active',
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    await seedLegacy(store, created.value, CONDITION, 1, [
      String(one.payload.id), String(two.payload.id),
    ]);
    const evaluated = await supervision.evaluateEvent(context(), { event: one });
    assert.equal(evaluated.ok, false);
    if (evaluated.ok) return;
    assert.equal(evaluated.error.code, 'RecoveryRequired');
    assert.equal(evaluated.error.details['stage'], 'legacy-occurrence-adoption');
    const notifications = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(notifications.ok, true);
    if (!notifications.ok) return;
    assert.equal(notifications.value.items.length, 1);
    const progress = await supervision.listWatchEvaluationProgress({
      id: 'ops_legacy' as never, kind: 'operations',
      verifiedScopes: ['supervision:watch:repair' as never],
    }, { state: 'recovery-required', limit: 20 });
    assert.equal(progress.ok, true);
    if (!progress.ok) return;
    assert.equal(progress.value.items.length, 1);
    assert.match(progress.value.items[0]!.recovery!.reason, /legacy(?: usage)? Notification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

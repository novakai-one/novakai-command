import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
} from '@novakai/foundation/contract';
import { composeSupervision } from '../core/index.js';
import type { ProviderUsageEvidence, RunUsageFacts } from '../contract/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never;
const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as never;
const HUMAN = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };

test('C20: an Agent-scoped satisfied condition commits for its matching final Run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-c20-occurrence-'));
  try {
    let ownedEvidence: ProviderUsageEvidence | null = null;
    const run = {
      agentRunId: RUN_ID,
      agentId: AGENT_ID,
      providerSessionId: SESSION_ID,
      lifecycle: 'stopped' as const,
      final: true,
      activityGeneration: 9 as never,
      recordVersion: 4 as never,
    };
    const supervision = composeSupervision({
      root,
      dataRoot: path.join(root, 'stores'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: {
        generationFor: async (_principal, subject) => subject.kind === 'agent-run'
          ? b3ok(run.activityGeneration)
          : b3fail(b3err(
              'WatcherConflict',
              'the Agent has no live Run to supply an activity generation',
              { subject, matchingLiveRuns: 0 },
              true,
            )),
      },
      usage: {
        runs: {
          getUsageRun: async () => b3ok(run),
          listUsageRuns: async () => b3ok([run]),
          resolveUsageRunByProviderSession: async () => b3ok(run),
          resolveCurrentRunByAgent: async () => b3ok(null),
          getRunOccurrenceEvent: async () => b3ok(null),
        },
        evidence: {
          getProviderUsageEvidence: async () => b3ok(ownedEvidence),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const created = await supervision.createWatchRule({
      principal: HUMAN,
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      subject: { kind: 'agent', agentId: AGENT_ID },
      condition: { kind: 'output-tokens-at-least', value: 1 },
      recipient: { kind: 'human', principalId: HUMAN.id },
      deliveryMode: 'queue-only',
      cooldownMs: 0,
      status: 'active',
    });
    assert.equal(created.ok, true, created.ok ? '' : created.error.message);

    const event = usageEvidenceEvent({
      quality: 'measured',
      inputTokens: 1,
      outputTokens: 2,
      cachedInputTokens: 0,
      costMicros: 1,
      providerTurns: 1,
      limitations: [],
      evidenceDigest: 'sha256:c20-final-run',
    });
    ownedEvidence = event.payload as unknown as ProviderUsageEvidence;
    const evaluated = await supervision.evaluateEvent({
      principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, { event });

    assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
    if (!evaluated.ok) return;
    assert.equal(evaluated.value.length, 1);
    const notification = evaluated.value[0] as unknown as Record<string, unknown>;
    assert.deepEqual(notification['subject'], { kind: 'agent', agentId: AGENT_ID });
    assert.equal(notification['schemaVersion'], 2);
    assert.equal(notification['conditionGeneration'], 9);
    assert.equal(notification['occurrenceIdentity'], 'agent-run');
    assert.equal(notification['qualifiedAt'], event.payload.observedAt);
    assert.deepEqual(notification['conditionOccurrence'], {
      kind: 'agent-run',
      agentRunId: RUN_ID,
      providerSessionId: SESSION_ID,
      qualifyingEvidenceRef: event.payload.id,
      qualifiedAt: event.payload.observedAt,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C20: two generation-1 Runs stay distinct and replay ignores later generation movement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-c20-two-runs-'));
  try {
    const secondRunId = 'agentRun_019fd000-0000-7000-8000-0000000000a2' as never;
    const secondSessionId = 'sess_123e4567-e89b-42d3-a456-426614174002' as never;
    const runs = new Map<string, RunUsageFacts>([
      [String(SESSION_ID), {
        agentRunId: RUN_ID, agentId: AGENT_ID, providerSessionId: SESSION_ID,
        lifecycle: 'stopped' as const, final: true, activityGeneration: 1 as never,
        recordVersion: 4 as never,
      }],
      [String(secondSessionId), {
        agentRunId: secondRunId, agentId: AGENT_ID, providerSessionId: secondSessionId,
        lifecycle: 'ready' as const, final: false, activityGeneration: 1 as never,
        recordVersion: 1 as never,
      }],
    ]);
    const evidence = new Map<string, ProviderUsageEvidence>();
    const supervision = composeSupervision({
      root, dataRoot: path.join(root, 'stores'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(1 as never) },
      usage: {
        runs: {
          getUsageRun: async (_principal, id) => b3ok(
            [...runs.values()].find((run) => run.agentRunId === id)!,
          ),
          listUsageRuns: async () => b3ok([...runs.values()]),
          resolveUsageRunByProviderSession: async (_principal, id) =>
            b3ok(runs.get(String(id)) ?? null),
          resolveCurrentRunByAgent: async () => b3ok(runs.get(String(secondSessionId))!),
          getRunOccurrenceEvent: async () => b3ok(null),
        },
        evidence: {
          getProviderUsageEvidence: async (_principal, id) =>
            b3ok(evidence.get(String(id)) ?? null),
          listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
        },
      },
    });
    const rule = await supervision.createWatchRule({
      principal: HUMAN, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }, {
      subject: { kind: 'agent', agentId: AGENT_ID },
      condition: { kind: 'output-tokens-at-least', value: 1 },
      recipient: { kind: 'human', principalId: HUMAN.id },
      deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
    });
    assert.equal(rule.ok, true);
    if (!rule.ok) return;
    const first = usageEvidenceEvent({
      quality: 'measured', inputTokens: 1, outputTokens: 2, cachedInputTokens: 0,
      costMicros: 1, providerTurns: 1, limitations: [], evidenceDigest: 'sha256:run-one',
    });
    const secondBase = usageEvidenceEvent({
      quality: 'measured', inputTokens: 1, outputTokens: 2, cachedInputTokens: 0,
      costMicros: 1, providerTurns: 1, limitations: [], evidenceDigest: 'sha256:run-two',
    }, 2);
    const second = {
      ...secondBase,
      payload: { ...secondBase.payload, providerSessionId: secondSessionId },
    } as ReturnType<typeof usageEvidenceEvent>;
    evidence.set(String(first.payload.id), first.payload as unknown as ProviderUsageEvidence);
    evidence.set(String(second.payload.id), second.payload as unknown as ProviderUsageEvidence);
    const firstResult = await supervision.evaluateEvent({
      principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1,
    }, { event: first });
    const secondResult = await supervision.evaluateEvent({
      principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1,
    }, { event: second });
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    if (!firstResult.ok || !secondResult.ok) return;
    assert.equal(firstResult.value.length, 1);
    assert.equal(secondResult.value.length, 1);
    assert.notEqual(firstResult.value[0]!.id, secondResult.value[0]!.id);
    assert.equal(firstResult.value[0]!.conditionGeneration, 1);
    assert.equal(secondResult.value[0]!.conditionGeneration, 1);

    runs.set(String(SESSION_ID), {
      ...runs.get(String(SESSION_ID))!, activityGeneration: 99 as never,
    });
    const redelivery = await supervision.evaluateEvent({
      principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1,
    }, { event: first });
    assert.equal(redelivery.ok, true);
    if (!redelivery.ok) return;
    assert.deepEqual(redelivery.value, []);
    const stored = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(stored.ok, true);
    if (!stored.ok) return;
    assert.equal(stored.value.items.length, 2);
    assert.equal(
      stored.value.items.find((item) => item.id === firstResult.value[0]!.id)!.conditionGeneration,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
} from '@novakai/foundation/contract';
import { composeSupervision } from '../core/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never;
const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as never;
const HUMAN = { id: 'person_chris' as never, kind: 'human' as const, verifiedScopes: [] };

test('C20: an Agent-scoped satisfied condition commits for its matching final Run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-c20-occurrence-'));
  try {
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
        },
        evidence: { listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }) },
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

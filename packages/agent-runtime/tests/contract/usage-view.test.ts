import test from 'node:test';
import assert from 'node:assert/strict';
import { b3ok } from '@novakai/foundation/contract';
import type { AgentRunUsage } from '../../../supervision/contract/index.js';
import { createRunsRig } from '../runs-harness.js';

const value = (
  quality: 'measured' | 'estimated' | 'partial' | 'unavailable',
  amount?: number,
) => ({
  quality,
  ...(amount === undefined ? {} : { value: amount }),
  source: 'agents:provider-usage-evidence',
  limitations: [],
});

test('AgentRunView embeds Supervision per-Run usage without reshaping it', async () => {
  let projectedRunId = '';
  const rig = createRunsRig({
    usage: async (_principal, agentRunId) => {
      projectedRunId = agentRunId;
      return b3ok<AgentRunUsage>({
        agentRunId,
        inputTokens: value('measured', 125),
        outputTokens: value('measured', 25),
        cachedInputTokens: value('measured', 10),
        costMicros: value('estimated', 42_000),
        providerTurns: value('measured', 1),
        observedAt: '2026-08-03T02:01:00.000Z' as never,
        final: false,
      });
    },
  });
  try {
    const role = rig.agents.defineRole('builder');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role,
      displayName: 'Usage Builder',
      workingDirectory: '/tmp/work',
      task: { kind: 'supervised', brief: 'exercise the usage view' },
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    assert.equal(projectedRunId, spawned.value.run.id);
    assert.equal(spawned.value.usage.agentRunId, spawned.value.run.id);
    assert.equal(spawned.value.usage.inputTokens.value, 125);
    assert.equal(spawned.value.usage.costMicros.quality, 'estimated');
  } finally {
    rig.close();
  }
});

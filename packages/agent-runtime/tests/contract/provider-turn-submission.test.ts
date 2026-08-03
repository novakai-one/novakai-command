import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  SystemCommandContext,
  TranscriptBindingId,
} from '@novakai/foundation/contract';
import { createRunsRig } from '../runs-harness.js';

test('one semantic system submission durably activates one exact Run tuple', async () => {
  const rig = createRunsRig({ gateMode: 'disabled' });
  try {
    const role = rig.agents.defineRole('interactive');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role,
      displayName: 'Interactive Agent',
      workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const binding = rig.transcriptCustody.bindings.find(
      (item) => item.agentRunId === String(spawned.value.run.id),
    );
    assert.ok(binding);
    const base = rig.human();
    const context: SystemCommandContext<'sys_agent_runtime'> = {
      ...base,
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      runtimeEpochId: rig.fence.epochId,
    };
    const input = {
      kind: 'runtime-effect' as const,
      source: 'agent-inbox-delivery' as const,
      sourceEffectKey: 'b3d:test:inbox:one',
      sourceObjectRef: 'agentInboxItem_test',
      agentRunId: spawned.value.run.id,
      terminalSessionId: spawned.value.run.terminalSessionId!,
      transcriptBindingId: binding!.id as TranscriptBindingId,
      utf8Text: 'Handle this one semantic message',
    };

    const submitted = await rig.runtime.submitProviderTurn(context, input);
    assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.message);
    if (!submitted.ok || submitted.value.kind === 'queued-not-yet-safe'
      || submitted.value.kind === 'not-submitted') return;
    assert.equal(submitted.value.kind, 'submitted-confirmed');
    assert.equal(
      submitted.value.activeTuple.activityGeneration,
      spawned.value.run.activityGeneration + 1,
    );
    assert.equal(rig.terminal.submitted.length, 1);
    const stateEvents = rig.events.filter((event) =>
      event.kind === 'agent.run.provider-turn-submission.changed');
    assert.deepEqual(stateEvents.map((event) =>
      (event.payload.state as { kind: string }).kind), [
      'queued', 'queued', 'prepared', 'submitted-confirmed', 'submitted-confirmed',
    ]);
    assert.equal(rig.events.some((event) => event.kind === 'agent.provider-turn.submitted'), false);

    const current = await rig.runtime.getAgentRun(rig.principal(), spawned.value.run.id);
    assert.equal(current.ok, true);
    if (current.ok) {
      assert.equal(current.value.run.activity, 'working');
      assert.equal(current.value.run.activeProviderTurn?.providerTurnId,
        submitted.value.submission.providerTurnId);
      assert.equal(current.value.run.providerTurnOperationFence?.phase, 'active');
    }
    const durable = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), submitted.value.submission.providerTurnId,
    );
    assert.equal(durable.ok, true);
    if (durable.ok) assert.equal(durable.value.state.kind, 'submitted-confirmed');

    const replay = await rig.runtime.submitProviderTurn(context, input);
    assert.equal(replay.ok, true);
    assert.equal(rig.terminal.submitted.length, 1, 'same root operation repeated the provider effect');
  } finally {
    rig.close();
  }
});

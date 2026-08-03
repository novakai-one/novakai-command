import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mintClientOpId, mintControllerAttachmentId, mintTerminalInputLeaseId,
  type CommandContext, type SystemCommandContext, type TranscriptBindingId,
} from '@novakai/foundation/contract';
import { createRunsRig } from '../runs-harness.js';

async function seededSystemRig() {
  const coordinated: string[] = [];
  const rig = createRunsRig({
    gateMode: 'disabled',
    providerTurnCompletionCoordinator: async (input) => {
      coordinated.push(String(input.providerTurnId));
      return {
        ok: true as const,
        value: {
          kind: 'evidence-not-yet-available' as const,
          missing: ['transcript'] as const,
          retryable: true as const,
        },
      };
    },
  });
  const role = rig.agents.defineRole('interactive');
  const spawned = await rig.runtime.spawnAgent(rig.human(), {
    roleProfileId: role,
    displayName: 'System Recovery Subject',
    workingDirectory: '/tmp/work',
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
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
    sourceEffectKey: `system-recovery:${base.clientOpId}`,
    sourceObjectRef: 'agentInboxItem_system-recovery',
    agentRunId: spawned.value.run.id,
    terminalSessionId: spawned.value.run.terminalSessionId!,
    transcriptBindingId: binding!.id as TranscriptBindingId,
    utf8Text: 'durable system turn snapshot',
  };
  return { rig, context, input, coordinated };
}

async function seededRig() {
  const rig = createRunsRig({ gateMode: 'disabled' });
  const role = rig.agents.defineRole('interactive');
  const spawned = await rig.runtime.spawnAgent(rig.human(), {
    roleProfileId: role, displayName: 'Recovery Subject', workingDirectory: '/tmp/work',
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
  const binding = rig.transcriptCustody.bindings.find(
    (item) => item.agentRunId === String(spawned.value.run.id),
  );
  assert.ok(binding);
  const context: CommandContext = {
    ...rig.human(), clientOpId: mintClientOpId(), runtimeEpochId: rig.fence.epochId,
  };
  const input = {
    kind: 'controller' as const,
    agentRunId: spawned.value.run.id,
    terminalSessionId: spawned.value.run.terminalSessionId!,
    transcriptBindingId: binding!.id as TranscriptBindingId,
    attachmentId: mintControllerAttachmentId(),
    inputLeaseId: mintTerminalInputLeaseId(),
    leaseGeneration: 1 as never,
    expectedNextInputSequence: 1,
    utf8Text: 'controller recovery turn',
  };
  return { rig, context, input };
}

for (const mode of ['startup', 'periodic'] as const) {
  test(`${mode} reconciliation cancels a queued controller attempt before rejecting it`, async () => {
    const { rig, context, input } = await seededRig();
    try {
      rig.terminal.crashAfterProviderTurnPrepare = true;
      await assert.rejects(
        () => rig.runtime.submitProviderTurn(context, input),
        /injected crash after durable Terminal provider-turn prepare/u,
      );
      const before = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
        includeTerminal: true, limit: 20,
      });
      assert.equal(before.ok, true);
      if (!before.ok) return;
      const queued = before.value.items.find((item) => item.origin.kind === 'controller');
      assert.equal(queued?.state.kind, 'queued');
      assert.ok(queued);

      const reconciled = mode === 'startup'
        ? await rig.runtime.reconcileAfterRestart()
        : await rig.runtime.reconcileProviderTurns();
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

      const after = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), queued!.providerTurnId,
      );
      assert.equal(after.ok, true);
      if (after.ok) {
        assert.equal(after.value.state.kind, 'rejected');
        if (after.value.state.kind === 'rejected') assert.equal(after.value.state.effectEscaped, false);
      }
      const attempt = await rig.terminal.getProviderTurnInputAttempt({
        terminalSessionId: queued!.terminalSessionId,
        providerTurnId: queued!.providerTurnId,
        submissionEffectKey: queued!.submissionEffectKey,
      });
      assert.equal(attempt.ok, true);
      if (attempt.ok && attempt.value !== null) {
        assert.equal(attempt.value.effectState.kind, 'rejected');
        assert.equal(attempt.value.turnBarrier.kind, 'released-rejected');
      }
      const run = await rig.runtime.getAgentRun(rig.principal(), queued!.agentRunId);
      assert.equal(run.ok, true);
      if (run.ok) assert.equal(run.value.run.providerTurnOperationFence, undefined);
    } finally {
      rig.close();
    }
  });
}

test('startup rejects a queued controller operation only after exact no-attempt proof', async () => {
  const { rig, context, input } = await seededRig();
  try {
    rig.terminal.providerTurnPrepareBlocked = true;
    const queued = await rig.runtime.submitProviderTurn(context, input);
    assert.equal(queued.ok, true);
    if (!queued.ok) return;
    assert.equal(queued.value.kind, 'queued-not-yet-safe');
    const reconciled = await rig.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
    const after = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), queued.value.submission.providerTurnId,
    );
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.value.state.kind, 'rejected');
    assert.equal(rig.terminal.submitted.length, 0);
  } finally {
    rig.close();
  }
});

test('startup cancels a prepared reservation and clears its Run fence before rejection', async () => {
  const { rig, context, input } = await seededRig();
  try {
    rig.terminal.crashOnProviderTurnExecute = true;
    await assert.rejects(
      () => rig.runtime.submitProviderTurn(context, input),
      /injected crash before Terminal provider-turn execute/u,
    );
    const before = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      includeTerminal: true, limit: 20,
    });
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const prepared = before.value.items.find((item) => item.origin.kind === 'controller');
    assert.equal(prepared?.state.kind, 'prepared');
    const fenced = await rig.runtime.getAgentRun(rig.principal(), prepared!.agentRunId);
    assert.equal(fenced.ok, true);
    if (fenced.ok) assert.equal(
      fenced.value.run.providerTurnOperationFence?.phase, 'submission-prepared',
    );
    const reconciled = await rig.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
    const after = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), prepared!.providerTurnId,
    );
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.value.state.kind, 'rejected');
    const run = await rig.runtime.getAgentRun(rig.principal(), prepared!.agentRunId);
    assert.equal(run.ok, true);
    if (run.ok) assert.equal(run.value.run.providerTurnOperationFence, undefined);
  } finally {
    rig.close();
  }
});

for (const cut of ['after-prepare', 'before-execute', 'after-execution-started'] as const) {
  test(`periodic recovery converges system submission ${cut} without a second effect`, async () => {
    const { rig, context, input, coordinated } = await seededSystemRig();
    try {
      if (cut === 'after-prepare') rig.terminal.crashAfterProviderTurnPrepare = true;
      if (cut === 'before-execute') rig.terminal.crashOnProviderTurnExecute = true;
      if (cut === 'after-execution-started') {
        rig.terminal.crashAfterProviderTurnExecutionStarted = true;
      }
      await assert.rejects(() => rig.runtime.submitProviderTurn(context, input), /injected crash/u);
      const before = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
        includeTerminal: true, limit: 20,
      });
      assert.equal(before.ok, true);
      if (!before.ok) return;
      const stranded = before.value.items.find((item) =>
        item.origin.kind === 'runtime-effect'
        && item.origin.sourceEffectKey === input.sourceEffectKey);
      assert.ok(stranded);

      const reconciled = await rig.runtime.reconcileProviderTurns();
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
      const after = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), stranded!.providerTurnId,
      );
      assert.equal(after.ok, true);
      if (!after.ok) return;
      assert.equal(
        after.value.state.kind,
        cut === 'after-execution-started' ? 'submitted-unconfirmed' : 'submitted-confirmed',
      );
      if (after.value.state.kind === 'submitted-confirmed'
        || after.value.state.kind === 'submitted-unconfirmed') {
        assert.equal(after.value.state.activation.state, 'committed');
      }
      assert.equal(rig.terminal.submitted.length, cut === 'after-execution-started' ? 0 : 1);
      assert.deepEqual(coordinated, [String(stranded!.providerTurnId)]);

      const replay = await rig.runtime.reconcileProviderTurns();
      assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
      assert.equal(rig.terminal.submitted.length, cut === 'after-execution-started' ? 0 : 1);
    } finally {
      rig.close();
    }
  });
}

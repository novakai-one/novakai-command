import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mintClientOpId, mintControllerAttachmentId, mintProviderSessionId,
  mintProviderTurnId, mintTerminalInputLeaseId, providerTurnSubmissionId,
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
  return { rig, context, input, coordinated, agentId: spawned.value.run.agentId };
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
  return { rig, context, input, agentId: spawned.value.run.agentId };
}

test('startup recovery leaves a queued system submission unchanged when its Run is final', async () => {
  const { rig, context, input, agentId } = await seededSystemRig();
  try {
    rig.terminal.providerTurnPrepareBlocked = true;
    const queued = await rig.runtime.submitProviderTurn(context, input);
    assert.equal(queued.ok, true, queued.ok ? '' : queued.error.message);
    if (!queued.ok) return;
    assert.equal(queued.value.kind, 'queued-not-yet-safe');
    if (queued.value.kind !== 'queued-not-yet-safe') return;
    assert.equal(queued.value.providerEffectCreated, false);
    assert.equal(queued.value.submission.state.kind, 'queued');

    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId,
      expectedLiveRunId: input.agentRunId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;
    assert.equal(stopped.value.run.lifecycle, 'stopped');

    const submissionBefore = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), queued.value.submission.providerTurnId,
    );
    const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    assert.equal(submissionBefore.ok, true);
    assert.equal(runBefore.ok, true);
    if (!submissionBefore.ok || !runBefore.ok) return;

    const reconciled = await rig.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

    const submissionAfter = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), queued.value.submission.providerTurnId,
    );
    const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    assert.deepEqual(submissionAfter, submissionBefore);
    assert.equal(runAfter.ok, true);
    if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
    assert.equal(rig.terminal.submitted.length, 0);
  } finally {
    rig.close();
  }
});

test('startup recovery leaves a prepared system submission unchanged when its Run is final', async () => {
  const { rig, context, input, coordinated, agentId } = await seededSystemRig();
  try {
    rig.terminal.crashOnProviderTurnExecute = true;
    await assert.rejects(
      () => rig.runtime.submitProviderTurn(context, input),
      /injected crash before Terminal provider-turn execute/u,
    );
    const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      includeTerminal: true, limit: 20,
    });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const prepared = listed.value.items.find((item) =>
      item.origin.kind === 'runtime-effect'
      && item.origin.sourceEffectKey === input.sourceEffectKey);
    assert.ok(prepared);
    assert.equal(prepared.state.kind, 'prepared');

    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId,
      expectedLiveRunId: input.agentRunId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;
    assert.equal(stopped.value.run.lifecycle, 'stopped');

    const submissionBefore = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), prepared.providerTurnId,
    );
    const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    const attemptBefore = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: prepared.terminalSessionId,
      providerTurnId: prepared.providerTurnId,
      submissionEffectKey: prepared.submissionEffectKey,
    });
    assert.equal(submissionBefore.ok, true);
    assert.equal(runBefore.ok, true);
    assert.equal(attemptBefore.ok, true);
    if (!submissionBefore.ok || !runBefore.ok || !attemptBefore.ok) return;

    const reconciled = await rig.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

    const submissionAfter = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), prepared.providerTurnId,
    );
    const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    const attemptAfter = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: prepared.terminalSessionId,
      providerTurnId: prepared.providerTurnId,
      submissionEffectKey: prepared.submissionEffectKey,
    });
    assert.deepEqual(submissionAfter, submissionBefore);
    assert.equal(runAfter.ok, true);
    if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
    assert.deepEqual(attemptAfter, attemptBefore);
    assert.equal(rig.terminal.submitted.length, 0);
    assert.deepEqual(coordinated, []);
  } finally {
    rig.close();
  }
});

test('startup recovery preserves submitted-unconfirmed uncertainty when its Run is final', async () => {
  const { rig, context, input, coordinated, agentId } = await seededSystemRig();
  try {
    rig.terminal.crashAfterProviderTurnExecutionStarted = true;
    await assert.rejects(
      () => rig.runtime.submitProviderTurn(context, input),
      /injected crash after Terminal provider-turn execution began/u,
    );
    const recovered = await rig.runtime.reconcileAfterRestart();
    assert.equal(recovered.ok, true, recovered.ok ? '' : recovered.error.message);
    assert.equal(coordinated.length, 1);

    const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      includeTerminal: true, limit: 20,
    });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const uncertain = listed.value.items.find((item) =>
      item.origin.kind === 'runtime-effect'
      && item.origin.sourceEffectKey === input.sourceEffectKey);
    assert.ok(uncertain);
    assert.equal(uncertain.state.kind, 'submitted-unconfirmed');

    const stopped = await rig.runtime.stopAgent(rig.human(), {
      agentId,
      expectedLiveRunId: input.agentRunId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;
    assert.equal(stopped.value.run.lifecycle, 'stopped');

    const submissionBefore = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), uncertain.providerTurnId,
    );
    const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    const attemptBefore = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: uncertain.terminalSessionId,
      providerTurnId: uncertain.providerTurnId,
      submissionEffectKey: uncertain.submissionEffectKey,
    });
    assert.equal(submissionBefore.ok, true);
    assert.equal(runBefore.ok, true);
    assert.equal(attemptBefore.ok, true);
    if (!submissionBefore.ok || !runBefore.ok || !attemptBefore.ok) return;

    const reconciled = await rig.runtime.reconcileAfterRestart();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

    const submissionAfter = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), uncertain.providerTurnId,
    );
    const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
    const attemptAfter = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: uncertain.terminalSessionId,
      providerTurnId: uncertain.providerTurnId,
      submissionEffectKey: uncertain.submissionEffectKey,
    });
    assert.deepEqual(submissionAfter, submissionBefore);
    assert.equal(runAfter.ok, true);
    if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
    assert.deepEqual(attemptAfter, attemptBefore);
    assert.equal(rig.terminal.submitted.length, 0);
    assert.equal(coordinated.length, 1);
  } finally {
    rig.close();
  }
});

test('startup recovery leaves a queued controller submission unchanged when its Run is final',
  async () => {
    const { rig, context, input, agentId } = await seededRig();
    try {
      rig.terminal.providerTurnPrepareBlocked = true;
      const queued = await rig.runtime.submitProviderTurn(context, input);
      assert.equal(queued.ok, true, queued.ok ? '' : queued.error.message);
      if (!queued.ok) return;
      assert.equal(queued.value.kind, 'queued-not-yet-safe');

      const stopped = await rig.runtime.stopAgent(rig.human(), {
        agentId,
        expectedLiveRunId: input.agentRunId,
        confirmation: 'stop-one',
      });
      assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
      if (!stopped.ok) return;
      assert.equal(stopped.value.run.lifecycle, 'stopped');

      const submissionBefore = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), queued.value.submission.providerTurnId,
      );
      const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.equal(submissionBefore.ok, true);
      assert.equal(runBefore.ok, true);
      if (!submissionBefore.ok || !runBefore.ok) return;

      const reconciled = await rig.runtime.reconcileAfterRestart();
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

      const submissionAfter = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), queued.value.submission.providerTurnId,
      );
      const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.deepEqual(submissionAfter, submissionBefore);
      assert.equal(runAfter.ok, true);
      if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
      assert.equal(rig.terminal.submitted.length, 0);
    } finally {
      rig.close();
    }
  });

test('startup recovery leaves a prepared controller submission unchanged when its Run is final',
  async () => {
    const { rig, context, input, agentId } = await seededRig();
    try {
      rig.terminal.crashOnProviderTurnExecute = true;
      await assert.rejects(
        () => rig.runtime.submitProviderTurn(context, input),
        /injected crash before Terminal provider-turn execute/u,
      );
      const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
        includeTerminal: true, limit: 20,
      });
      assert.equal(listed.ok, true);
      if (!listed.ok) return;
      const prepared = listed.value.items.find((item) => item.origin.kind === 'controller');
      assert.ok(prepared);
      assert.equal(prepared.state.kind, 'prepared');

      const stopped = await rig.runtime.stopAgent(rig.human(), {
        agentId,
        expectedLiveRunId: input.agentRunId,
        confirmation: 'stop-one',
      });
      assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
      if (!stopped.ok) return;
      assert.equal(stopped.value.run.lifecycle, 'stopped');

      const submissionBefore = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), prepared.providerTurnId,
      );
      const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      const attemptBefore = await rig.terminal.getProviderTurnInputAttempt({
        terminalSessionId: prepared.terminalSessionId,
        providerTurnId: prepared.providerTurnId,
        submissionEffectKey: prepared.submissionEffectKey,
      });
      assert.equal(submissionBefore.ok, true);
      assert.equal(runBefore.ok, true);
      assert.equal(attemptBefore.ok, true);
      if (!submissionBefore.ok || !runBefore.ok || !attemptBefore.ok) return;

      const reconciled = await rig.runtime.reconcileAfterRestart();
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

      const submissionAfter = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), prepared.providerTurnId,
      );
      const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      const attemptAfter = await rig.terminal.getProviderTurnInputAttempt({
        terminalSessionId: prepared.terminalSessionId,
        providerTurnId: prepared.providerTurnId,
        submissionEffectKey: prepared.submissionEffectKey,
      });
      assert.deepEqual(submissionAfter, submissionBefore);
      assert.equal(runAfter.ok, true);
      if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
      assert.deepEqual(attemptAfter, attemptBefore);
      assert.equal(rig.terminal.submitted.length, 0);
    } finally {
      rig.close();
    }
  });

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

test('reconciliation quarantines a Terminal attempt with no Runtime submission identity', async () => {
  const { rig, input } = await seededSystemRig();
  try {
    const providerTurnId = mintProviderTurnId();
    const orphanSubmissionId = providerTurnSubmissionId(
      input.agentRunId,
      { kind: 'runtime-effect', source: 'agent-inbox-delivery' },
      'orphan-terminal-attempt',
    );
    const prepared = await rig.terminal.prepareProviderTurnInput({
      terminalSessionId: input.terminalSessionId,
      agentRunId: input.agentRunId,
      providerTurnSubmissionId: orphanSubmissionId,
      deliveryAttemptOrdinal: 1,
      providerSessionId: mintProviderSessionId(),
      transcriptBindingId: input.transcriptBindingId,
      startTranscriptWatermark: null,
      expectedRunRecordVersion: 1 as never,
      providerTurnId,
      activityGeneration: 2 as never,
      submissionEffectKey: 'orphan-terminal-attempt',
      inputDigest: 'a'.repeat(64),
      utf8Text: 'orphan',
      authority: {
        kind: 'runtime-safe-boundary', source: 'agent-inbox-delivery',
        sourceEffectKey: 'orphan-terminal-attempt', sourceObjectRef: 'orphan',
        expectedNoActiveInputLease: true, expectedNoControllerDraft: true,
      },
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok || prepared.value.kind !== 'prepared') return;
    const reconciled = await rig.runtime.reconcileProviderTurns();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
    assert.deepEqual(rig.terminal.quarantinedProviderTurnAttemptIds, [prepared.value.attempt.id]);
    const remaining = await rig.terminal.listIncompleteProviderTurnInputAttempts({});
    assert.equal(remaining.ok, true);
    if (remaining.ok) assert.equal(remaining.value.length, 0);
  } finally {
    rig.close();
  }
});

test('startup recovery quarantines an orphan Terminal attempt without mutating its final Run',
  async () => {
    const { rig, input, agentId } = await seededSystemRig();
    try {
      const providerTurnId = mintProviderTurnId();
      const orphanSubmissionId = providerTurnSubmissionId(
        input.agentRunId,
        { kind: 'runtime-effect', source: 'agent-inbox-delivery' },
        'final-orphan-terminal-attempt',
      );
      const prepared = await rig.terminal.prepareProviderTurnInput({
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
        providerTurnSubmissionId: orphanSubmissionId,
        deliveryAttemptOrdinal: 1,
        providerSessionId: mintProviderSessionId(),
        transcriptBindingId: input.transcriptBindingId,
        startTranscriptWatermark: null,
        expectedRunRecordVersion: 1 as never,
        providerTurnId,
        activityGeneration: 2 as never,
        submissionEffectKey: 'final-orphan-terminal-attempt',
        inputDigest: 'b'.repeat(64),
        utf8Text: 'final orphan',
        authority: {
          kind: 'runtime-safe-boundary', source: 'agent-inbox-delivery',
          sourceEffectKey: 'final-orphan-terminal-attempt', sourceObjectRef: 'final-orphan',
          expectedNoActiveInputLease: true, expectedNoControllerDraft: true,
        },
      });
      assert.equal(prepared.ok, true);
      if (!prepared.ok || prepared.value.kind !== 'prepared') return;

      const stopped = await rig.runtime.stopAgent(rig.human(), {
        agentId,
        expectedLiveRunId: input.agentRunId,
        confirmation: 'stop-one',
      });
      assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
      if (!stopped.ok) return;
      assert.equal(stopped.value.run.lifecycle, 'stopped');
      const runBefore = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.equal(runBefore.ok, true);
      if (!runBefore.ok) return;

      const reconciled = await rig.runtime.reconcileAfterRestart();
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
      assert.deepEqual(rig.terminal.quarantinedProviderTurnAttemptIds, [prepared.value.attempt.id]);
      const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.equal(runAfter.ok, true);
      if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBefore.value.run);
      const remaining = await rig.terminal.listIncompleteProviderTurnInputAttempts({});
      assert.equal(remaining.ok, true);
      if (remaining.ok) assert.equal(remaining.value.length, 0);
    } finally {
      rig.close();
    }
  });

test('periodic recovery leaves a queued system submission unchanged when its Run stops mid-lookup',
  async () => {
    const { rig, context, input, agentId } = await seededSystemRig();
    try {
      rig.terminal.providerTurnPrepareBlocked = true;
      const queued = await rig.runtime.submitProviderTurn(context, input);
      assert.equal(queued.ok, true, queued.ok ? '' : queued.error.message);
      if (!queued.ok) return;
      assert.equal(queued.value.kind, 'queued-not-yet-safe');
      const submissionBefore = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), queued.value.submission.providerTurnId,
      );
      assert.equal(submissionBefore.ok, true);
      if (!submissionBefore.ok) return;

      let lookupEntered!: () => void;
      const entered = new Promise<void>((resolve) => { lookupEntered = resolve; });
      let releaseLookup!: () => void;
      const released = new Promise<void>((resolve) => { releaseLookup = resolve; });
      rig.terminal.duringNextProviderTurnInputAttemptLookup = async () => {
        lookupEntered();
        await released;
      };
      rig.terminal.providerTurnPrepareBlocked = false;
      const reconciliation = rig.runtime.reconcileProviderTurns();
      await entered;

      const stopped = await rig.runtime.stopAgent(rig.human(), {
        agentId,
        expectedLiveRunId: input.agentRunId,
        confirmation: 'stop-one',
      });
      assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
      if (!stopped.ok) return;
      assert.equal(stopped.value.run.lifecycle, 'stopped');
      const runBeforeRelease = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.equal(runBeforeRelease.ok, true);
      if (!runBeforeRelease.ok) return;

      releaseLookup();
      const reconciled = await reconciliation;
      assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);

      const submissionAfter = await rig.runtime.getProviderTurnSubmission(
        rig.principal(), queued.value.submission.providerTurnId,
      );
      const runAfter = await rig.runtime.getAgentRun(rig.principal(), input.agentRunId);
      assert.deepEqual(submissionAfter, submissionBefore);
      assert.equal(runAfter.ok, true);
      if (runAfter.ok) assert.deepEqual(runAfter.value.run, runBeforeRelease.value.run);
      assert.equal(rig.terminal.submitted.length, 0);
    } finally {
      rig.close();
    }
  });

test('an executing attempt without Runtime prepared state and fence is quarantined', async () => {
  const { rig, context, input } = await seededSystemRig();
  try {
    rig.terminal.crashAfterProviderTurnPrepare = true;
    await assert.rejects(
      () => rig.runtime.submitProviderTurn(context, input),
      /injected crash after durable Terminal provider-turn prepare/u,
    );
    const submissions = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      includeTerminal: true, limit: 20,
    });
    assert.equal(submissions.ok, true);
    if (!submissions.ok) return;
    const queued = submissions.value.items.find((item) =>
      item.origin.kind === 'runtime-effect'
      && item.origin.sourceEffectKey === input.sourceEffectKey);
    assert.ok(queued);
    const attempt = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: queued!.terminalSessionId,
      providerTurnId: queued!.providerTurnId,
      submissionEffectKey: queued!.submissionEffectKey,
    });
    assert.equal(attempt.ok, true);
    if (!attempt.ok || attempt.value === null) return;
    rig.terminal.crashAfterProviderTurnExecutionStarted = true;
    await assert.rejects(() => rig.terminal.executeProviderTurnInput({
      terminalInputAttemptId: attempt.value!.id,
      expectedAttemptRecordVersion: attempt.value!.recordVersion,
      submissionEffectKey: queued!.submissionEffectKey,
      providerTurnId: queued!.providerTurnId,
      activityGeneration: queued!.activationTarget.activityGeneration,
      utf8Text: input.utf8Text,
    }), /injected crash after Terminal provider-turn execution began/u);

    const reconciled = await rig.runtime.reconcileProviderTurns();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
    assert.deepEqual(rig.terminal.quarantinedProviderTurnAttemptIds, [attempt.value.id]);
    const held = await rig.runtime.getProviderTurnSubmission(rig.principal(), queued!.providerTurnId);
    assert.equal(held.ok, true);
    if (held.ok) assert.equal(held.value.state.kind, 'recovery-required');
    assert.equal(rig.terminal.submitted.length, 0);
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

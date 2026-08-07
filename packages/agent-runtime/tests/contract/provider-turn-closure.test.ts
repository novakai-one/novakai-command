import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  mintClientOpId,
  type AuthorityScope,
  type ProviderTurnSubmissionId,
  type SystemCommandContext,
  type TranscriptBindingId,
} from '@novakai/foundation/contract';
import type { ProviderTurnSubmission } from '../../contract/provider-turns.js';
import { createRunsStore } from '../../core/runs-store.js';
import { createRunsRig } from '../runs-harness.js';

const REPAIR = ['agent.provider-turn.repair' as AuthorityScope];

async function seedSystemTurn(options: {
  readonly coordinatorUnproven?: boolean;
  readonly crashAfterPrepare?: boolean;
  readonly crashBeforeExecute?: boolean;
  readonly blockedBeforeAttempt?: boolean;
} = {}) {
  const rig = createRunsRig({
    gateMode: 'disabled',
    ...(options.coordinatorUnproven === true
      ? {
          providerTurnCompletionCoordinator: async () => ({
            ok: true as const,
            value: {
              kind: 'completion-boundary-unproven' as const,
              status: 'uncertain' as const,
              reason: 'fixture source gap',
              evidenceRefs: ['fixture-source-gap'],
              retryable: false,
            },
          }),
        }
      : {}),
  });
  const role = rig.agents.defineRole('interactive');
  const spawned = await rig.runtime.spawnAgent(rig.human(), {
    roleProfileId: role, displayName: 'Repair Subject', workingDirectory: '/tmp/work',
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
  if (options.crashAfterPrepare === true) rig.terminal.crashAfterProviderTurnPrepare = true;
  if (options.crashBeforeExecute === true) rig.terminal.crashOnProviderTurnExecute = true;
  if (options.blockedBeforeAttempt === true) rig.terminal.providerTurnPrepareBlocked = true;
  const submitted = rig.runtime.submitProviderTurn(context, {
    kind: 'runtime-effect', source: 'agent-inbox-delivery',
    sourceEffectKey: `closure:${base.clientOpId}`, sourceObjectRef: 'inbox_closure',
    agentRunId: spawned.value.run.id,
    terminalSessionId: spawned.value.run.terminalSessionId!,
    transcriptBindingId: binding!.id as TranscriptBindingId,
    utf8Text: 'repair this exact semantic turn',
  });
  return { rig, spawned: spawned.value, submitted };
}

async function forceRecovery(
  root: string,
  submission: ProviderTurnSubmission,
  terminalInputAttemptId?: ProviderTurnSubmission['state'] extends never ? never : string,
): Promise<ProviderTurnSubmission> {
  const store = createRunsStore({ root, dataRoot: path.join(root, 'stores') });
  const updated = await store.update<ProviderTurnSubmission>(
    'sys_agent_runtime', submission.id as ProviderTurnSubmissionId, {
      state: {
        kind: 'recovery-required',
        enteredAt: '2026-08-03T06:00:00.000Z',
        lastSafeState: submission.state.kind === 'prepared' ? 'prepared' : 'queued',
        ...(terminalInputAttemptId === undefined ? {} : { terminalInputAttemptId }),
        reason: 'fixture corruption evidence',
        evidenceRefs: ['fixture-corruption'],
      },
    }, submission.recordVersion, mintClientOpId(),
  );
  assert.equal(updated.ok, true, updated.ok ? '' : updated.error.message);
  if (!updated.ok) throw new Error('fixture update failed');
  return updated.value;
}

test('unproven-final closure is scope-gated and waits for both liveness owners', async () => {
  const { rig, spawned, submitted } = await seedSystemTurn({ coordinatorUnproven: true });
  try {
    const active = await submitted;
    assert.equal(active.ok, true, active.ok ? '' : active.error.message);
    if (!active.ok || active.value.kind === 'queued-not-yet-safe'
      || active.value.kind === 'not-submitted') return;
    const submission = active.value.submission;
    const reconciled = await rig.runtime.reconcileProviderTurns();
    assert.equal(reconciled.ok, true, reconciled.ok ? '' : reconciled.error.message);
    const held = await rig.runtime.getProviderTurnSubmission(rig.principal(), submission.providerTurnId);
    assert.equal(held.ok, true);
    if (!held.ok || held.value.state.kind !== 'recovery-required') return;

    const input = {
      agentRunId: submission.agentRunId,
      providerTurnId: submission.providerTurnId,
      expectedActiveTuple: active.value.activeTuple,
      terminalInputAttemptId: held.value.state.terminalInputAttemptId!,
      reason: 'operator accepts an unprovable terminal boundary',
      completionEvidenceRefs: ['operations-case-1'] as readonly [string, ...string[]],
    };
    const denied = await rig.runtime.closeProviderTurnCompletionUnproven(rig.human([]), input);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'PermissionDenied');

    const waiting = await rig.runtime.closeProviderTurnCompletionUnproven(
      rig.human(REPAIR), input,
    );
    assert.equal(waiting.ok, true, waiting.ok ? '' : waiting.error.message);
    if (waiting.ok) assert.equal(waiting.value.kind, 'provider-still-live-or-unknown');

    await rig.terminal.terminate({
      terminalSessionId: spawned.run.terminalSessionId!,
      agentRunId: spawned.run.id,
      expectedRuntimeEpochId: rig.fence.epochId,
      reason: 'stop-one',
    });
    rig.providers.sessionLiveness = 'final';
    const generationBefore = active.value.activeTuple.activityGeneration;
    const closed = await rig.runtime.closeProviderTurnCompletionUnproven(
      rig.human(REPAIR), input,
    );
    assert.equal(closed.ok, true, closed.ok ? '' : closed.error.message);
    if (closed.ok) assert.equal(closed.value.kind, 'run-finalised-completion-unproven');
    const run = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(run.ok, true);
    if (run.ok) {
      assert.equal(run.value.run.lifecycle, 'failed');
      assert.equal(run.value.run.activity, 'unknown');
      assert.equal(run.value.run.activityGeneration, generationBefore + 1);
      assert.equal(run.value.run.activeProviderTurn, undefined);
      assert.equal(run.value.run.lastCompletedProviderTurn, undefined);
    }
    const finalSubmission = await rig.runtime.getProviderTurnSubmission(
      rig.principal(), submission.providerTurnId,
    );
    assert.equal(finalSubmission.ok, true);
    if (finalSubmission.ok) assert.equal(
      finalSubmission.value.state.kind, 'completion-unproven-final',
    );
  } finally {
    rig.close();
  }
});

test('no-effect repair cancels the exact prepared reservation and clears only its fence', async () => {
  const { rig, submitted } = await seedSystemTurn({ crashBeforeExecute: true });
  try {
    await assert.rejects(() => submitted, /injected crash/u);
    const listed = await rig.runtime.listProviderTurnSubmissions(rig.principal(), {
      includeTerminal: true, limit: 20,
    });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const prepared = listed.value.items.find((item) => item.state.kind === 'prepared');
    assert.ok(prepared);
    const attempt = await rig.terminal.getProviderTurnInputAttempt({
      terminalSessionId: prepared!.terminalSessionId,
      providerTurnId: prepared!.providerTurnId,
      submissionEffectKey: prepared!.submissionEffectKey,
    });
    assert.equal(attempt.ok, true);
    assert.ok(attempt.ok && attempt.value !== null);
    await forceRecovery(rig.root, prepared!, attempt.ok ? attempt.value?.id : undefined);

    const before = await rig.runtime.getAgentRun(rig.principal(), prepared!.agentRunId);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const repaired = await rig.runtime.closeProviderTurnCompletionUnproven(
      rig.human(REPAIR), {
        agentRunId: prepared!.agentRunId,
        providerTurnId: prepared!.providerTurnId,
        terminalInputAttemptId: attempt.ok ? attempt.value!.id : undefined,
        reason: 'discard corrupt pre-effect submission',
        completionEvidenceRefs: ['operations-case-2'],
      },
    );
    assert.equal(repaired.ok, true, repaired.ok ? '' : repaired.error.message);
    if (repaired.ok && repaired.value.kind === 'submission-rejected-no-effect') {
      assert.equal(repaired.value.terminalReservationCancelled, true);
      assert.equal(repaired.value.runFenceCleared, true);
      assert.equal(repaired.value.runActivityChanged, false);
      assert.equal(repaired.value.completionClaimed, false);
      assert.deepEqual(repaired.value.submission.state.kind, 'rejected');
    }
    const after = await rig.runtime.getAgentRun(rig.principal(), prepared!.agentRunId);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.value.run.activityGeneration, before.value.run.activityGeneration);
      assert.equal(after.value.run.providerTurnOperationFence, undefined);
    }
  } finally {
    rig.close();
  }
});

test('no-attempt repair rejects only after Terminal and Run prove no effect exists', async () => {
  const { rig, submitted } = await seedSystemTurn({ blockedBeforeAttempt: true });
  try {
    const queued = await submitted;
    assert.equal(queued.ok, true, queued.ok ? '' : queued.error.message);
    if (!queued.ok) return;
    assert.equal(queued.value.kind, 'queued-not-yet-safe');
    const submission = queued.value.submission;
    await forceRecovery(rig.root, submission);
    const before = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const repaired = await rig.runtime.closeProviderTurnCompletionUnproven(
      rig.human(REPAIR), {
        agentRunId: submission.agentRunId,
        providerTurnId: submission.providerTurnId,
        reason: 'discard corrupt identity before Terminal preparation',
        completionEvidenceRefs: ['operations-case-3'],
      },
    );
    assert.equal(repaired.ok, true, repaired.ok ? '' : repaired.error.message);
    if (repaired.ok && repaired.value.kind === 'submission-rejected-no-effect') {
      assert.equal(repaired.value.terminalInputAttemptId, undefined);
      assert.equal(repaired.value.terminalReservationCancelled, false);
      assert.equal(repaired.value.runFenceCleared, false);
      assert.equal(repaired.value.completionClaimed, false);
    }
    const after = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(after.ok, true);
    if (after.ok) {
      assert.equal(after.value.run.activityGeneration, before.value.run.activityGeneration);
      assert.equal(after.value.run.activity, before.value.run.activity);
    }
  } finally {
    rig.close();
  }
});

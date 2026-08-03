import assert from 'node:assert/strict';
import test from 'node:test';
import {
  b3err, b3fail, b3ok, deterministicId, mintClientOpId,
  mintTraceCorrelationId, transcriptTurnCompletionId,
  type ProviderUsageEvidenceId, type SystemCommandContext, type TranscriptBindingId,
  type TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import type { ProviderTurnSubmission } from '../../contract/provider-turns.js';
import { createRunsRig, type FakeFence } from '../runs-harness.js';

const reconciler = (fence: FakeFence): SystemCommandContext<'sys_reconciler'> => ({
  principal: { id: 'sys_reconciler', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
  runtimeEpochId: fence.epochId,
});

test('exact owner facts complete one tuple once and an old replay cannot mutate its successor', async () => {
  let submission: ProviderTurnSubmission | null = null;
  let completionId = '' as TranscriptTurnCompletionId;
  let evidenceId = '' as ProviderUsageEvidenceId;
  const observedAt = '2026-08-03T04:05:06.000Z' as never;
  const completionDigest = 'd'.repeat(64);
  const rig = createRunsRig({
    gateMode: 'disabled',
    providerTurnCompletionEvidence: {
      async getTranscriptCompletion(id) {
        if (submission === null || id !== completionId) {
          return b3fail(b3err('TranscriptSourceUnavailable', 'not ready', {}, true));
        }
        return b3ok({
          id: completionId,
          providerTurnId: submission.providerTurnId,
          agentRunId: submission.agentRunId,
          providerSessionId: submission.providerSessionId,
          providerConversationId: submission.providerConversationId,
          transcriptBindingId: submission.transcriptBindingId,
          completionTranscriptWatermark: '0000000042',
          completionEvidenceDigest: completionDigest,
          observedAt,
        });
      },
      async getUsageEvidence(id) {
        if (submission === null || id !== evidenceId) {
          return b3fail(b3err('UsageUnavailable', 'not ready', {}, true));
        }
        return b3ok({
          id: evidenceId,
          providerSessionId: submission.providerSessionId,
          providerConversationId: submission.providerConversationId,
          observedAt,
          source: 'transcript-turn-completion',
          sourceCursor: '0000000042',
          scope: {
            kind: 'runtime-turn-completion',
            agentRunId: submission.agentRunId,
            providerTurnId: submission.providerTurnId,
            transcriptTurnCompletionId: completionId,
          },
          measurement: {
            quality: 'partial', providerTurns: 1, evidenceDigest: completionDigest,
          },
        });
      },
    },
  });
  try {
    const role = rig.agents.defineRole('interactive');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role, displayName: 'Completer', workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const binding = rig.transcriptCustody.bindings.find(
      (item) => item.agentRunId === String(spawned.value.run.id),
    );
    assert.ok(binding);
    const runtimeContext: SystemCommandContext<'sys_agent_runtime'> = {
      ...reconciler(rig.fence),
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    };
    const submitted = await rig.runtime.submitProviderTurn(runtimeContext, {
      kind: 'runtime-effect', source: 'agent-inbox-delivery',
      sourceEffectKey: 'completion-test:first', sourceObjectRef: 'inbox_first',
      agentRunId: spawned.value.run.id,
      terminalSessionId: spawned.value.run.terminalSessionId!,
      transcriptBindingId: binding!.id as TranscriptBindingId,
      utf8Text: 'first semantic turn',
    });
    assert.equal(submitted.ok, true, submitted.ok ? '' : submitted.error.message);
    if (!submitted.ok || submitted.value.kind === 'queued-not-yet-safe'
      || submitted.value.kind === 'not-submitted') return;
    submission = submitted.value.submission;
    completionId = transcriptTurnCompletionId(
      submission.transcriptBindingId, submission.providerTurnId,
    );
    evidenceId = deterministicId('providerUsage', [
      String(submission.providerSessionId), 'runtime-turn-completion',
      String(submission.agentRunId), String(submission.providerTurnId), String(completionId),
    ]) as ProviderUsageEvidenceId;
    const completionInput = {
      agentRunId: submission.agentRunId,
      providerTurnId: submission.providerTurnId,
      expectedActiveTuple: {
        providerTurnId: submission.providerTurnId,
        activityGeneration: submission.activationTarget.activityGeneration,
      },
      transcriptTurnCompletionId: completionId,
      providerUsageEvidenceId: evidenceId,
    };
    const generationBefore = submission.activationTarget.activityGeneration;
    const [left, right] = await Promise.all([
      rig.runtime.completeProviderTurn(reconciler(rig.fence), completionInput),
      rig.runtime.completeProviderTurn(reconciler(rig.fence), completionInput),
    ]);
    assert.equal(left.ok, true, left.ok ? '' : left.error.message);
    assert.equal(right.ok, true, right.ok ? '' : right.error.message);
    const completed = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(completed.ok, true);
    if (!completed.ok) return;
    assert.equal(completed.value.run.activityGeneration, generationBefore + 1);
    assert.equal(completed.value.run.activity, 'idle');
    assert.equal(completed.value.run.activeProviderTurn, undefined);
    assert.equal(completed.value.run.lastCompletedProviderTurn?.providerTurnId,
      submission.providerTurnId);

    const second = await rig.runtime.submitProviderTurn({
      ...runtimeContext, clientOpId: mintClientOpId(),
    }, {
      kind: 'runtime-effect', source: 'agent-inbox-delivery',
      sourceEffectKey: 'completion-test:second', sourceObjectRef: 'inbox_second',
      agentRunId: submission.agentRunId,
      terminalSessionId: submission.terminalSessionId,
      transcriptBindingId: submission.transcriptBindingId,
      utf8Text: 'second semantic turn',
    });
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    if (!second.ok || second.value.kind === 'queued-not-yet-safe'
      || second.value.kind === 'not-submitted') return;
    const beforeOldReplay = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(beforeOldReplay.ok, true);
    const replay = await rig.runtime.completeProviderTurn(reconciler(rig.fence), completionInput);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    const afterOldReplay = await rig.runtime.getAgentRun(rig.principal(), submission.agentRunId);
    assert.equal(afterOldReplay.ok, true);
    if (beforeOldReplay.ok && afterOldReplay.ok) {
      assert.equal(afterOldReplay.value.run.activityGeneration,
        beforeOldReplay.value.run.activityGeneration);
      assert.equal(afterOldReplay.value.run.activeProviderTurn?.providerTurnId,
        second.value.submission.providerTurnId);
    }
  } finally {
    rig.close();
  }
});

test('missing owner facts are retryable and do not move generation', async () => {
  const rig = createRunsRig({
    gateMode: 'disabled',
    providerTurnCompletionEvidence: {
      async getTranscriptCompletion() {
        return b3fail(b3err('TranscriptSourceUnavailable', 'not yet', {}, true));
      },
      async getUsageEvidence() {
        return b3fail(b3err('UsageUnavailable', 'not yet', {}, true));
      },
    },
  });
  try {
    const role = rig.agents.defineRole('interactive');
    const spawned = await rig.runtime.spawnAgent(rig.human(), {
      roleProfileId: role, displayName: 'Waiter', workingDirectory: '/tmp/work',
    });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    const binding = rig.transcriptCustody.bindings.find(
      (item) => item.agentRunId === String(spawned.value.run.id),
    )!;
    const submitted = await rig.runtime.submitProviderTurn({
      ...reconciler(rig.fence),
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    }, {
      kind: 'runtime-effect', source: 'watcher-status-request',
      sourceEffectKey: 'owner-wait', sourceObjectRef: 'watch_status',
      agentRunId: spawned.value.run.id,
      terminalSessionId: spawned.value.run.terminalSessionId!,
      transcriptBindingId: binding.id as TranscriptBindingId,
      utf8Text: 'status?',
    });
    assert.equal(submitted.ok, true);
    if (!submitted.ok || submitted.value.kind === 'queued-not-yet-safe'
      || submitted.value.kind === 'not-submitted') return;
    const before = submitted.value.activeTuple.activityGeneration;
    const outcome = await rig.runtime.completeProviderTurn(reconciler(rig.fence), {
      agentRunId: spawned.value.run.id,
      providerTurnId: submitted.value.submission.providerTurnId,
      expectedActiveTuple: submitted.value.activeTuple,
      transcriptTurnCompletionId: transcriptTurnCompletionId(
        binding.id as TranscriptBindingId, submitted.value.submission.providerTurnId,
      ),
      providerUsageEvidenceId: deterministicId('providerUsage', ['missing']) as never,
    });
    assert.equal(outcome.ok, true);
    if (outcome.ok) assert.equal(outcome.value.kind, 'evidence-not-yet-available');
    const after = await rig.runtime.getAgentRun(rig.principal(), spawned.value.run.id);
    assert.equal(after.ok, true);
    if (after.ok) assert.equal(after.value.run.activityGeneration, before);
  } finally {
    rig.close();
  }
});

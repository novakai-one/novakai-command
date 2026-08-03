import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicId,
  mintProviderSessionId,
  mintProviderTurnId,
  providerTurnSubmissionId,
  type ActivityGeneration,
  type ProviderUsageEvidenceId,
  type RecordVersion,
  type TranscriptBindingId,
  type TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import {
  createRig, expectError, humanContext, humanPrincipal, openMockManagedSession,
  runtimeContext, someAgentRunId, unwrap,
} from '../harness.js';

const GENERATION = 7 as ActivityGeneration;
const RUN_VERSION = 3 as RecordVersion;
const TEXT = 'Perform the frozen semantic turn';
const EFFECT_KEY = 'b3d:test:provider-turn:1';
const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

test('runtime semantic input is prepared before bytes and executes at most once', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const providerTurnId = mintProviderTurnId();
    const providerSessionId = mintProviderSessionId();
    const transcriptBindingId = deterministicId(
      'transcriptBinding', ['terminal-provider-turn-test'],
    ) as TranscriptBindingId;
    const submissionId = providerTurnSubmissionId(
      someAgentRunId,
      { kind: 'runtime-effect', source: 'skills-gate' },
      EFFECT_KEY,
    );
    const prepared = unwrap(await rig.terminal.prepareProviderTurnInput(runtimeContext(), {
      terminalSessionId: session.id,
      agentRunId: someAgentRunId,
      providerTurnSubmissionId: submissionId,
      deliveryAttemptOrdinal: 1,
      providerSessionId,
      transcriptBindingId,
      startTranscriptWatermark: null,
      expectedRunRecordVersion: RUN_VERSION,
      providerTurnId,
      activityGeneration: GENERATION,
      submissionEffectKey: EFFECT_KEY,
      inputDigest: digest(TEXT),
      utf8Text: TEXT,
      authority: {
        kind: 'runtime-safe-boundary',
        source: 'skills-gate',
        sourceEffectKey: EFFECT_KEY,
        sourceObjectRef: 'skills-gate:test',
        expectedNoActiveInputLease: true,
        expectedNoControllerDraft: true,
      },
    }), 'prepare semantic input');
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    assert.deepEqual(rig.ptyHost.latest().written, [], 'preparation moved provider bytes');

    const executed = unwrap(await rig.terminal.executeProviderTurnInput(runtimeContext(), {
      terminalInputAttemptId: prepared.attempt.id,
      expectedAttemptRecordVersion: prepared.attempt.recordVersion,
      submissionEffectKey: EFFECT_KEY,
      providerTurnId,
      activityGeneration: GENERATION,
      utf8Text: TEXT,
    }), 'execute semantic input');
    assert.equal(executed.effectState.kind, 'submitted-confirmed');
    assert.deepEqual(rig.ptyHost.latest().written, [TEXT, '\r']);

    const replay = unwrap(await rig.terminal.executeProviderTurnInput(runtimeContext(), {
      terminalInputAttemptId: prepared.attempt.id,
      expectedAttemptRecordVersion: prepared.attempt.recordVersion,
      submissionEffectKey: EFFECT_KEY,
      providerTurnId,
      activityGeneration: GENERATION,
      utf8Text: TEXT,
    }), 'replay semantic input');
    assert.equal(replay.id, executed.id);
    assert.deepEqual(rig.ptyHost.latest().written, [TEXT, '\r'], 'retry submitted a second turn');
  } finally {
    await rig.dispose();
  }
});

test('runtime preparation waits for both controller lease and draft boundaries', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const controller = unwrap(await rig.terminal.attachController(humanContext(), {
      terminalSessionId: session.id,
      controllerKind: 'novakai-shell',
      columns: 100,
      rows: 30,
    }), 'attach controller');
    const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id,
      attachmentId: controller.id,
      mode: 'acquire-if-free',
      ttlMs: 30_000,
    }), 'acquire lease');
    const providerTurnId = mintProviderTurnId();
    const submissionEffectKey = 'b3d:test:safe-boundary';
    const base = {
      terminalSessionId: session.id,
      agentRunId: someAgentRunId,
      providerTurnSubmissionId: providerTurnSubmissionId(
        someAgentRunId,
        { kind: 'runtime-effect' as const, source: 'agent-inbox-delivery' as const },
        submissionEffectKey,
      ),
      deliveryAttemptOrdinal: 1,
      providerSessionId: mintProviderSessionId(),
      transcriptBindingId: deterministicId(
        'transcriptBinding', ['terminal-safe-boundary-test'],
      ) as TranscriptBindingId,
      startTranscriptWatermark: null,
      expectedRunRecordVersion: RUN_VERSION,
      providerTurnId,
      activityGeneration: GENERATION,
      submissionEffectKey,
      inputDigest: digest(TEXT),
      utf8Text: TEXT,
      authority: {
        kind: 'runtime-safe-boundary' as const,
        source: 'agent-inbox-delivery' as const,
        sourceEffectKey: submissionEffectKey,
        sourceObjectRef: 'inbox:test',
        expectedNoActiveInputLease: true as const,
        expectedNoControllerDraft: true as const,
      },
    };
    const leaseBlocked = unwrap(
      await rig.terminal.prepareProviderTurnInput(runtimeContext(), base),
      'lease-blocked prepare',
    );
    assert.equal(leaseBlocked.kind, 'not-yet-safe');
    if (leaseBlocked.kind === 'not-yet-safe') {
      assert.equal(leaseBlocked.blocking.kind, 'active-input-lease');
    }

    unwrap(await rig.terminal.releaseInputLease(humanContext(), {
      terminalSessionId: session.id,
      attachmentId: controller.id,
      leaseId: lease.id,
      generation: lease.generation,
    }), 'release lease');
    unwrap(await rig.terminal.setControllerDraftState(humanContext(), {
      attachmentId: controller.id,
      expectedDraftGeneration: 0,
      state: 'present',
    }), 'mark draft present');
    const draftBlocked = unwrap(
      await rig.terminal.prepareProviderTurnInput(runtimeContext(), base),
      'draft-blocked prepare',
    );
    assert.equal(draftBlocked.kind, 'not-yet-safe');
    if (draftBlocked.kind === 'not-yet-safe') {
      assert.equal(draftBlocked.blocking.kind, 'controller-draft');
    }
    assert.deepEqual(rig.ptyHost.latest().written, []);
  } finally {
    await rig.dispose();
  }
});

test('durable completion wins before a later interrupt and changes no input lease', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const providerTurnId = mintProviderTurnId();
    const submissionEffectKey = 'b3d:test:completion-before-interrupt';
    const prepared = unwrap(await rig.terminal.prepareProviderTurnInput(runtimeContext(), {
      terminalSessionId: session.id,
      agentRunId: someAgentRunId,
      providerTurnSubmissionId: providerTurnSubmissionId(
        someAgentRunId,
        { kind: 'runtime-effect', source: 'watcher-status-request' },
        submissionEffectKey,
      ),
      deliveryAttemptOrdinal: 1,
      providerSessionId: mintProviderSessionId(),
      transcriptBindingId: deterministicId(
        'transcriptBinding', ['terminal-completion-race-test'],
      ) as TranscriptBindingId,
      startTranscriptWatermark: null,
      expectedRunRecordVersion: RUN_VERSION,
      providerTurnId,
      activityGeneration: GENERATION,
      submissionEffectKey,
      inputDigest: digest(TEXT),
      utf8Text: TEXT,
      authority: {
        kind: 'runtime-safe-boundary',
        source: 'watcher-status-request',
        sourceEffectKey: submissionEffectKey,
        sourceObjectRef: 'watcher:test',
        expectedNoActiveInputLease: true,
        expectedNoControllerDraft: true,
      },
    }), 'prepare');
    assert.equal(prepared.kind, 'prepared');
    if (prepared.kind !== 'prepared') return;
    unwrap(await rig.terminal.executeProviderTurnInput(runtimeContext(), {
      terminalInputAttemptId: prepared.attempt.id,
      expectedAttemptRecordVersion: prepared.attempt.recordVersion,
      submissionEffectKey,
      providerTurnId,
      activityGeneration: GENERATION,
      utf8Text: TEXT,
    }), 'execute');
    const transcriptTurnCompletionId = deterministicId(
      'transcriptTurnCompletion', ['terminal-race-test'],
    ) as TranscriptTurnCompletionId;
    const providerUsageEvidenceId = deterministicId(
      'providerUsageEvidence', ['terminal-race-test'],
    ) as ProviderUsageEvidenceId;
    const settled = unwrap(await rig.terminal.settleProviderTurnCompletion(runtimeContext(), {
      terminalInputAttemptId: prepared.attempt.id,
      agentRunId: someAgentRunId,
      providerTurnId,
      activityGeneration: GENERATION,
      transcriptTurnCompletionId,
      providerUsageEvidenceId,
    }), 'settle completion');
    assert.equal(settled.kind, 'completion-barrier-committed');

    const interrupted = unwrap(await rig.terminal.interruptTerminalTurn(
      runtimeContext(rig.epochId), {
        terminalSessionId: session.id,
        agentRunId: someAgentRunId,
        providerTurnId,
        activityGeneration: GENERATION,
        expectedRuntimeEpochId: rig.epochId,
      },
    ), 'interrupt completed turn');
    assert.equal(interrupted.kind, 'target-turn-not-active');
    assert.deepEqual(rig.ptyHost.latest().written, [TEXT, '\r']);
    const persisted = unwrap(await rig.terminal.getProviderTurnInputAttempt(
      humanPrincipal(), { terminalSessionId: session.id, providerTurnId, submissionEffectKey },
    ), 'read attempt');
    assert.equal(persisted.turnBarrier.kind, 'completion-committed');
  } finally {
    await rig.dispose();
  }
});

test('unknown semantic attempts are typed conflicts', async () => {
  const rig = createRig();
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const result = await rig.terminal.getProviderTurnInputAttempt(humanPrincipal(), {
      terminalSessionId: session.id,
      providerTurnId: mintProviderTurnId(),
      submissionEffectKey: 'absent',
    });
    assert.equal(expectError(result, 'missing attempt').code, 'ProviderTurnSubmissionConflict');
  } finally {
    await rig.dispose();
  }
});

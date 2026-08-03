/* eslint-disable id-length -- `run` is the AgentRun aggregate; `now` is its clock sample. */
/* eslint-disable max-lines -- Frozen submission, recovery, and completion form one aggregate owner. */

import { createHash } from 'node:crypto';
import {
  b3err,
  b3fail,
  b3ok,
  deriveClientOpId,
  keysetPage,
  mintClientOpId,
  mintProviderTurnId,
  mintTraceCorrelationId,
  providerTurnSubmissionId,
  type ActivityGeneration,
  type B3Result,
  type CommandContext,
  type IsoUtc,
  type ProviderTurnSubmissionId,
} from '@novakai/foundation/contract';
import type {
  CloseProviderTurnCompletionUnprovenInput,
  CloseProviderTurnCompletionUnprovenOutcome,
  CompleteProviderTurnInput,
  CompleteProviderTurnOutcome,
  CompletedProviderTurnOutcome,
  ProviderTurnSubmission,
  ProviderTurnSubmissionFilter,
  ProviderTurnSubmissionPage,
  ProviderTurnSubmitInput,
  ProviderTurnSubmitOutcome,
} from '../contract/provider-turns.js';
import { FINAL_LIFECYCLES, type AgentRun } from '../contract/runs.js';
import type { ProviderTurnInputAttemptFacts } from '../contract/ports.js';
import { patchRun, requireRun, type RunsCore } from './runs-context.js';
import type { Persisted } from './runs-store.js';

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const now = (core: RunsCore): IsoUtc => new Date(core.clock()).toISOString() as IsoUtc;

const operationConflict = (
  submission: Pick<ProviderTurnSubmission, 'id' | 'providerTurnId'>,
  reason: string,
) => b3fail(b3err('ProviderTurnSubmissionConflict', reason, {
  providerTurnSubmissionId: submission.id,
  providerTurnId: submission.providerTurnId,
  reason,
  evidenceRefs: [submission.id],
}, false));

async function patchSubmission(
  core: RunsCore,
  submission: ProviderTurnSubmission,
  patch: Partial<Persisted<ProviderTurnSubmission>>,
): Promise<B3Result<ProviderTurnSubmission>> {
  const written = await core.store.update<ProviderTurnSubmission>(
    'sys_agent_runtime', submission.id, patch as Record<string, unknown>,
    submission.recordVersion, mintClientOpId(),
  );
  if (written.ok && patch.state !== undefined) publishSubmissionChanged(core, written.value);
  return written;
}

function publishSubmissionChanged(
  core: RunsCore, submission: ProviderTurnSubmission,
  traceId?: import('@novakai/foundation/contract').TraceCorrelationId,
): void {
  core.publish('agent.run.provider-turn-submission.changed', {
    agentRunId: submission.agentRunId,
    providerTurnId: submission.providerTurnId,
    providerTurnSubmissionId: submission.id,
    state: submission.state,
  }, traceId);
}

function effectKey(context: CommandContext, input: ProviderTurnSubmitInput): string {
  return input.kind === 'controller'
    ? String(deriveClientOpId(
      `${input.agentRunId}:controller-provider-turn-submit:${context.clientOpId}`,
    ))
    : input.sourceEffectKey;
}

function origin(context: CommandContext, input: ProviderTurnSubmitInput): ProviderTurnSubmission['origin'] {
  return input.kind === 'controller'
    ? {
        kind: 'controller',
        attachmentId: input.attachmentId,
        inputLeaseId: input.inputLeaseId,
        leaseGeneration: input.leaseGeneration,
        inputSequence: input.expectedNextInputSequence,
        requestingPrincipalId: context.principal.id,
      }
    : {
        kind: 'runtime-effect',
        source: input.source,
        sourceEffectKey: input.sourceEffectKey,
        sourceObjectRef: input.sourceObjectRef,
        requestingSystemPrincipalId: 'sys_agent_runtime',
      };
}

function sameResume(
  submission: ProviderTurnSubmission,
  input: ProviderTurnSubmitInput,
  submissionEffectKey: string,
  inputDigest: string,
  expectedOrigin: ProviderTurnSubmission['origin'],
): boolean {
  const recoverableLogicalInput = input.kind === 'controller'
    ? { kind: 'controller-replay-only' as const }
    : { kind: 'runtime-effect-snapshot' as const, utf8Text: input.utf8Text };
  return submission.agentRunId === input.agentRunId
    && submission.terminalSessionId === input.terminalSessionId
    && submission.transcriptBindingId === input.transcriptBindingId
    && submission.submissionEffectKey === submissionEffectKey
    && submission.inputDigest === inputDigest
    && JSON.stringify(submission.recoverableLogicalInput) === JSON.stringify(recoverableLogicalInput)
    && JSON.stringify(submission.origin) === JSON.stringify(expectedOrigin);
}

function terminalOutcome(submission: ProviderTurnSubmission): ProviderTurnSubmitOutcome | null {
  if (submission.state.kind === 'submitted-confirmed') {
    return {
      kind: 'submitted-confirmed',
      submission,
      terminalInputAttemptId: submission.state.terminalInputAttemptId,
      activeTuple: submission.activationTarget,
    };
  }
  if (submission.state.kind === 'submitted-unconfirmed') {
    return {
      kind: 'submitted-unconfirmed',
      submission,
      terminalInputAttemptId: submission.state.terminalInputAttemptId,
      activeTuple: submission.activationTarget,
      retryForbidden: true,
    };
  }
  if (submission.state.kind === 'completed'
    || submission.state.kind === 'rejected'
    || submission.state.kind === 'completion-unproven-final') {
    return { kind: 'not-submitted', submission, effectEscaped: false };
  }
  return null;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Frozen transaction cut ordering is explicit here.
export async function submitProviderTurn(
  core: RunsCore,
  context: CommandContext,
  input: ProviderTurnSubmitInput,
): Promise<B3Result<ProviderTurnSubmitOutcome>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  if (input.kind === 'runtime-effect' || context.principal.kind === 'system') {
    if (input.kind !== 'runtime-effect' || context.principal.id !== 'sys_agent_runtime') {
      return b3fail(b3err('PermissionDenied', 'runtime-effect submission requires sys_agent_runtime', {
        principalId: context.principal.id,
      }, false));
    }
  }
  const runResult = await requireRun(core, input.agentRunId);
  if (!runResult.ok) return runResult;
  let run = runResult.value;
  if (FINAL_LIFECYCLES.has(run.lifecycle)) {
    return b3fail(b3err('RunFinal', 'a final Run cannot accept a provider turn', {
      agentRunId: run.id, lifecycle: run.lifecycle,
    }, false));
  }
  if (run.terminalSessionId !== input.terminalSessionId) {
    return b3fail(b3err('ProviderTurnSubmissionConflict', 'terminal does not belong to the Run', {
      providerTurnSubmissionId: 'uncommitted', providerTurnId: 'uncommitted',
      reason: 'terminal-session-mismatch', evidenceRefs: [run.id],
    }, false));
  }

  const providerSession = await core.agents.getProviderSession(
    context.principal, run.providerSessionId,
  );
  if (!providerSession.ok) return providerSession;
  const boundary = await core.providers.turnBoundaryCapability(providerSession.value.provider);
  if (!boundary.ok
    || boundary.value.testedProviderVersion !== providerSession.value.providerVersion) {
    return b3fail(b3err('ProviderTurnBoundaryUnavailable',
      'no validated provider-turn boundary matches the active executable version', {
        provider: providerSession.value.provider,
        activeProviderVersion: providerSession.value.providerVersion,
        testedProviderVersion: boundary.ok ? boundary.value.testedProviderVersion : null,
      }, false));
  }
  const binding = await core.transcriptBinding?.(run.id);
  if (binding === undefined || binding === null
    || binding.bindingState === 'missing' || binding.bindingState === 'corrupt'
    || binding.bindingId !== input.transcriptBindingId) {
    return b3fail(b3err('TranscriptSourceUnavailable',
      'the exact Run transcript binding is not available', {
        agentRunId: run.id, transcriptBindingId: input.transcriptBindingId,
      }, true));
  }

  const submissionEffectKey = effectKey(context, input);
  const inputDigest = digest(input.utf8Text);
  const expectedOrigin = origin(context, input);
  const id = providerTurnSubmissionId(
    run.id,
    expectedOrigin.kind === 'controller'
      ? { kind: 'controller' }
      : { kind: 'runtime-effect', source: expectedOrigin.source },
    submissionEffectKey,
  );
  let found = await core.store.read<ProviderTurnSubmission>('providerTurnSubmission', id);
  if (!found.ok) return found;
  let submission = found.value;
  if (submission !== null && !sameResume(
    submission, input, submissionEffectKey, inputDigest, expectedOrigin,
  )) return operationConflict(submission, 'immutable resume fields differ');

  if (submission === null) {
    const providerTurnId = mintProviderTurnId();
    const activationGeneration = (run.activityGeneration + 1) as ActivityGeneration;
    const created: Persisted<ProviderTurnSubmission> = {
      kind: 'providerTurnSubmission',
      id,
      schemaVersion: 1,
      createdAt: now(core),
      permissionLevel: 'private',
      createdBy: context.principal.id,
      providerTurnId,
      agentRunId: run.id,
      providerSessionId: run.providerSessionId,
      providerConversationId: providerSession.value.providerConversationId,
      terminalSessionId: input.terminalSessionId,
      transcriptBindingId: input.transcriptBindingId,
      runtimeEpochId: epoch.value,
      submissionEffectKey,
      inputDigest,
      recoverableLogicalInput: input.kind === 'controller'
        ? { kind: 'controller-replay-only' }
        : { kind: 'runtime-effect-snapshot', utf8Text: input.utf8Text },
      startTranscriptWatermark: binding.mirrorWatermark ?? null,
      activationTarget: {
        expectedRunRecordVersion: run.recordVersion,
        providerTurnId,
        activityGeneration: activationGeneration,
      },
      origin: expectedOrigin,
      state: { kind: 'queued', queuedAt: now(core), deliveryAttemptOrdinal: 0 },
    };
    const written = await core.store.create<ProviderTurnSubmission>(
      context.principal.id, created as Persisted<ProviderTurnSubmission> & Record<string, unknown>,
      mintClientOpId(),
    );
    if (!written.ok) return written;
    submission = written.value;
    publishSubmissionChanged(core, submission, context.traceId);
  }

  const settled = terminalOutcome(submission);
  if (settled !== null) return b3ok(settled);
  if (submission.state.kind !== 'queued') {
    return b3fail(b3err('ProviderTurnOperationInProgress',
      'the provider-turn submission requires reconciliation before resuming', {
        providerTurnSubmissionId: submission.id,
        state: submission.state.kind,
      }, true));
  }

  const refreshedRun = await requireRun(core, input.agentRunId);
  if (!refreshedRun.ok) return refreshedRun;
  run = refreshedRun.value;
  if (run.providerTurnOperationFence !== undefined || run.activeProviderTurn !== undefined) {
    return b3ok({
      kind: 'queued-not-yet-safe',
      submissionEffectKey,
      blocking: { kind: 'active-provider-turn' },
      submission,
      retryable: true,
      providerEffectCreated: false,
    });
  }
  const queuedAt = submission.state.queuedAt;
  const ordinal = submission.state.deliveryAttemptOrdinal + 1;
  const activationTarget = {
    expectedRunRecordVersion: run.recordVersion,
    providerTurnId: submission.providerTurnId,
    activityGeneration: (run.activityGeneration + 1) as ActivityGeneration,
  };
  const snapshotted = await patchSubmission(core, submission, {
    startTranscriptWatermark: binding.mirrorWatermark ?? null,
    activationTarget,
    state: { kind: 'queued', queuedAt, deliveryAttemptOrdinal: ordinal },
  });
  if (!snapshotted.ok) return snapshotted;
  submission = snapshotted.value;

  const prepared = await core.terminal.prepareProviderTurnInput({
    terminalSessionId: input.terminalSessionId,
    agentRunId: run.id,
    providerTurnSubmissionId: submission.id,
    deliveryAttemptOrdinal: ordinal,
    providerSessionId: submission.providerSessionId,
    transcriptBindingId: submission.transcriptBindingId,
    startTranscriptWatermark: submission.startTranscriptWatermark,
    expectedRunRecordVersion: activationTarget.expectedRunRecordVersion,
    providerTurnId: submission.providerTurnId,
    activityGeneration: activationTarget.activityGeneration,
    submissionEffectKey,
    inputDigest,
    utf8Text: input.utf8Text,
    authority: input.kind === 'controller'
      ? {
          kind: 'controller',
          attachmentId: input.attachmentId,
          inputLeaseId: input.inputLeaseId,
          leaseGeneration: input.leaseGeneration,
          expectedNextInputSequence: input.expectedNextInputSequence,
          requestingPrincipalId: context.principal.id,
        }
      : {
          kind: 'runtime-safe-boundary',
          source: input.source,
          sourceEffectKey: input.sourceEffectKey,
          sourceObjectRef: input.sourceObjectRef,
          expectedNoActiveInputLease: true,
          expectedNoControllerDraft: true,
        },
  });
  if (!prepared.ok) {
    if (input.kind === 'controller') {
      await patchSubmission(core, submission, {
        state: {
          kind: 'rejected', rejectedAt: now(core), reason: prepared.error.message,
          effectEscaped: false, evidenceRefs: [prepared.error.code],
        },
      });
    }
    return prepared;
  }
  if (prepared.value.kind === 'not-yet-safe') {
    const blocked = await patchSubmission(core, submission, {
      state: {
        kind: 'queued',
        queuedAt,
        deliveryAttemptOrdinal: ordinal,
        lastBlockingReason: prepared.value.blocking.kind,
      },
    });
    if (!blocked.ok) return blocked;
    return b3ok({
      kind: 'queued-not-yet-safe',
      submissionEffectKey,
      blocking: prepared.value.blocking,
      submission: blocked.value,
      retryable: true,
      providerEffectCreated: false,
    });
  }

  const attempt = prepared.value.attempt;
  const fenced = await patchRun(core, run, {
    providerTurnOperationFence: {
      providerTurnId: submission.providerTurnId,
      providerTurnSubmissionId: submission.id,
      terminalInputAttemptId: attempt.id,
      commandClientOpId: context.clientOpId,
      submissionEffectKey,
      activityGeneration: activationTarget.activityGeneration,
      ...(attempt.authority.kind === 'controller'
        ? { controllerResumeDeadlineAt: attempt.authority.resumeDeadlineAt }
        : {}),
      acquiredAt: now(core),
      phase: 'terminal-prepared',
    },
  });
  if (!fenced.ok) {
    await core.terminal.cancelPreparedProviderTurnInput({
      terminalInputAttemptId: attempt.id,
      expectedAttemptRecordVersion: attempt.recordVersion,
      reason: 'run-target-changed',
    });
    return b3fail(b3err('TargetChanged', 'the Run changed before activation fencing', {
      agentRunId: run.id,
    }, false));
  }
  run = fenced.value;
  const preparedSubmission = await patchSubmission(core, submission, {
    state: {
      kind: 'prepared', preparedAt: now(core), deliveryAttemptOrdinal: ordinal,
      activation: { state: 'pending' },
    },
  });
  if (!preparedSubmission.ok) return preparedSubmission;
  submission = preparedSubmission.value;
  const submissionFenced = await patchRun(core, run, {
    providerTurnOperationFence: {
      ...run.providerTurnOperationFence!, phase: 'submission-prepared',
    },
  });
  if (!submissionFenced.ok) return submissionFenced;
  run = submissionFenced.value;

  const executed = await core.terminal.executeProviderTurnInput({
    terminalInputAttemptId: attempt.id,
    expectedAttemptRecordVersion: attempt.recordVersion,
    submissionEffectKey,
    providerTurnId: submission.providerTurnId,
    activityGeneration: activationTarget.activityGeneration,
    utf8Text: input.utf8Text,
  });
  if (!executed.ok) return executed;
  if (executed.value.effectState.kind !== 'submitted-confirmed'
    && executed.value.effectState.kind !== 'submitted-unconfirmed') {
    return b3fail(b3err('RecoveryRequired', 'Terminal did not return a submitted state', {
      operationId: submission.id, stage: executed.value.effectState.kind,
      reason: 'terminal-effect-state-not-submitted',
    }, true));
  }
  const submittedAt = executed.value.effectState.submittedAt;
  const submissionState = executed.value.effectState.kind === 'submitted-confirmed'
    ? {
        kind: 'submitted-confirmed' as const,
        terminalInputAttemptId: attempt.id,
        submittedAt,
        activation: { state: 'pending' as const },
      }
    : {
        kind: 'submitted-unconfirmed' as const,
        terminalInputAttemptId: attempt.id,
        submittedAt,
        uncertaintyReason: executed.value.effectState.reason,
        activation: { state: 'pending' as const },
      };
  const submitted = await patchSubmission(core, submission, { state: submissionState });
  if (!submitted.ok) return submitted;
  submission = submitted.value;

  const activatedAt = now(core);
  const activated = await patchRun(core, run, {
    activity: 'working',
    activityGeneration: activationTarget.activityGeneration,
    activeProviderTurn: {
      providerTurnId: submission.providerTurnId,
      activityGeneration: activationTarget.activityGeneration,
      startedAt: activatedAt,
      state: 'working',
    },
    providerTurnOperationFence: {
      ...run.providerTurnOperationFence!, phase: 'active',
    },
  });
  if (!activated.ok) return activated;
  const committed = await patchSubmission(core, submission, {
    state: {
      ...submissionState,
      activation: {
        state: 'committed',
        committedRunRecordVersion: activated.value.recordVersion,
        activatedAt,
      },
    },
  });
  if (!committed.ok) return committed;
  return b3ok(submissionState.kind === 'submitted-confirmed'
    ? {
        kind: 'submitted-confirmed', submission: committed.value,
        terminalInputAttemptId: attempt.id, activeTuple: activationTarget,
      }
    : {
        kind: 'submitted-unconfirmed', submission: committed.value,
        terminalInputAttemptId: attempt.id, activeTuple: activationTarget,
        retryForbidden: true,
      });
}

export async function getProviderTurnSubmission(
  core: RunsCore,
  providerTurnId: ProviderTurnSubmission['providerTurnId'],
): Promise<B3Result<ProviderTurnSubmission>> {
  const listed = await core.store.list<ProviderTurnSubmission>(
    'providerTurnSubmission', { providerTurnId },
  );
  if (!listed.ok) return listed;
  const submission = listed.value[0];
  return submission === undefined
    ? b3fail(b3err('UnknownProviderTurnSubmission', 'no provider-turn submission exists', {
      providerTurnId,
    }, false))
    : b3ok(submission);
}

export async function listProviderTurnSubmissions(
  core: RunsCore,
  filter: ProviderTurnSubmissionFilter,
): Promise<B3Result<ProviderTurnSubmissionPage>> {
  const listed = await core.store.list<ProviderTurnSubmission>('providerTurnSubmission', {
    ...(filter.agentRunId === undefined ? {} : { agentRunId: filter.agentRunId }),
    ...(filter.providerSessionId === undefined
      ? {}
      : { providerSessionId: filter.providerSessionId }),
  });
  if (!listed.ok) return listed;
  const terminal = new Set(['completed', 'rejected', 'completion-unproven-final']);
  const items = listed.value
    .filter((item) => filter.includeTerminal || !terminal.has(item.state.kind))
    .filter((item) => filter.states === undefined || filter.states.includes(item.state.kind));
  return keysetPage(items, filter);
}

/**
 * Startup's controller pre-effect law (R3 N2-L1/N2-L2). A controller's bytes
 * are deliberately not durable, so a dead process may reject the old logical
 * operation only after Terminal proves no effect began. A prepared reservation
 * is cancelled before either the Run fence or submission is released.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Exhaustive R3 pre-effect recovery matrix.
export async function reconcileControllerPreEffectSubmissions(
  core: RunsCore,
  mode: 'startup' | 'periodic',
): Promise<B3Result<readonly ProviderTurnSubmissionId[]>> {
  const listed = await core.store.list<ProviderTurnSubmission>('providerTurnSubmission');
  if (!listed.ok) return listed;
  const reconciled: ProviderTurnSubmissionId[] = [];
  const candidates = listed.value
    .filter((submission) => submission.origin.kind === 'controller'
      && (submission.state.kind === 'queued' || submission.state.kind === 'prepared'))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));
  for (const stale of candidates) {
    let submission = stale;
    const attemptResult = await core.terminal.getProviderTurnInputAttempt({
      terminalSessionId: submission.terminalSessionId,
      providerTurnId: submission.providerTurnId,
      submissionEffectKey: submission.submissionEffectKey,
    });
    if (!attemptResult.ok) return attemptResult;
    const attempt = attemptResult.value;
    if (attempt !== null && (attempt.effectState.kind !== 'prepared'
      || attempt.turnBarrier.kind !== 'reserved-pre-effect')) {
      // Execution/submission is recovered by the general pass below. It must
      // never be labelled no-effect or re-issued merely because the caller's
      // logical bytes were deliberately not persisted.
      continue;
    }
    if (mode === 'periodic') {
      const runResult = await requireRun(core, submission.agentRunId);
      if (!runResult.ok) return runResult;
      const deadline = runResult.value.providerTurnOperationFence?.controllerResumeDeadlineAt;
      // A merely queued controller operation has no owner deadline proving its
      // authenticated root command stopped resuming. Startup is R3 N2-L1's
      // deterministic bound; the periodic pass therefore leaves that row.
      if (attempt === null && deadline === undefined) continue;
      if (deadline !== undefined && core.clock() < Date.parse(deadline)) continue;
    }
    if (attempt !== null) {
      const cancelled = await core.terminal.cancelPreparedProviderTurnInput({
        terminalInputAttemptId: attempt.id,
        expectedAttemptRecordVersion: attempt.recordVersion,
        reason: 'runtime-preparation-rejected',
      });
      if (!cancelled.ok) return cancelled;
    }
    const runResult = await requireRun(core, submission.agentRunId);
    if (!runResult.ok) return runResult;
    let run = runResult.value;
    if (run.providerTurnOperationFence?.providerTurnSubmissionId === submission.id) {
      const cleared = await patchRun(core, run, { providerTurnOperationFence: undefined });
      if (!cleared.ok) return cleared;
      run = cleared.value;
    }
    const rejected = await patchSubmission(core, submission, {
      state: {
        kind: 'rejected', rejectedAt: now(core),
        ...(attempt === null ? {} : { terminalInputAttemptId: attempt.id }),
        reason: attempt === null
          ? 'startup proved no Terminal attempt exists'
          : 'startup cancelled the prepared pre-effect Terminal reservation',
        effectEscaped: false,
        evidenceRefs: attempt === null ? [] : [attempt.id],
      },
    });
    if (!rejected.ok) return rejected;
    submission = rejected.value;
    void run;
    reconciled.push(submission.id);
  }
  return b3ok(reconciled);
}

function attemptMatchesSubmission(
  attempt: ProviderTurnInputAttemptFacts,
  submission: ProviderTurnSubmission,
): boolean {
  return attempt.terminalSessionId === submission.terminalSessionId
    && attempt.agentRunId === submission.agentRunId
    && attempt.providerTurnSubmissionId === submission.id
    && attempt.providerTurnId === submission.providerTurnId
    && attempt.activityGeneration === submission.activationTarget.activityGeneration
    && attempt.submissionEffectKey === submission.submissionEffectKey
    && attempt.providerSessionId === submission.providerSessionId
    && attempt.transcriptBindingId === submission.transcriptBindingId
    && attempt.payloadDigest === submission.inputDigest;
}

async function holdForRecovery(
  core: RunsCore,
  submission: ProviderTurnSubmission,
  reason: string,
  evidenceRefs: readonly string[],
  attempt?: ProviderTurnInputAttemptFacts,
): Promise<B3Result<ProviderTurnSubmission>> {
  if (submission.state.kind === 'recovery-required') return b3ok(submission);
  const lastSafeState = submission.state.kind === 'queued'
    || submission.state.kind === 'prepared'
    || submission.state.kind === 'submitted-confirmed'
    || submission.state.kind === 'submitted-unconfirmed'
    ? submission.state.kind
    : null;
  if (lastSafeState === null) return operationConflict(
    submission, `cannot move ${submission.state.kind} into recovery-required`,
  );
  const held = await patchSubmission(core, submission, {
    state: {
      kind: 'recovery-required', enteredAt: now(core), lastSafeState,
      ...(attempt === undefined ? {} : { terminalInputAttemptId: attempt.id }),
      reason, evidenceRefs,
    },
  });
  if (!held.ok) return held;
  const runResult = await requireRun(core, submission.agentRunId);
  if (!runResult.ok) return runResult;
  const fence = runResult.value.providerTurnOperationFence;
  if (fence?.providerTurnSubmissionId === submission.id && fence.phase !== 'recovery-required') {
    const fenced = await patchRun(core, runResult.value, {
      providerTurnOperationFence: { ...fence, phase: 'recovery-required' },
    });
    if (!fenced.ok) return fenced;
  }
  return held;
}

function storedSystemInput(submission: ProviderTurnSubmission): string | null {
  return submission.recoverableLogicalInput.kind === 'runtime-effect-snapshot'
    ? submission.recoverableLogicalInput.utf8Text
    : null;
}

function systemReplayContext(core: RunsCore, submission: ProviderTurnSubmission): CommandContext {
  const runtimeEpochId = core.fence.activeEpochId();
  return {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: deriveClientOpId(`agent.reconcileProviderTurn:${submission.id}`),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
    ...(runtimeEpochId === null ? {} : { runtimeEpochId }),
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Durable recovery phases must remain visibly ordered.
async function recoverAttemptedSubmission(
  core: RunsCore,
  submission: ProviderTurnSubmission,
  initialAttempt: ProviderTurnInputAttemptFacts,
): Promise<B3Result<ProviderTurnSubmission>> {
  if (!attemptMatchesSubmission(initialAttempt, submission)) {
    return holdForRecovery(core, submission,
      'Terminal attempt lineage differs from the Runtime submission',
      [submission.id, initialAttempt.id], initialAttempt);
  }
  let attempt = initialAttempt;
  let runResult = await requireRun(core, submission.agentRunId);
  if (!runResult.ok) return runResult;
  let run = runResult.value;
  let fence = run.providerTurnOperationFence;
  const matchingFence = fence !== undefined
    && fence.providerTurnSubmissionId === submission.id
    && fence.providerTurnId === submission.providerTurnId
    && fence.terminalInputAttemptId === attempt.id
    && fence.submissionEffectKey === submission.submissionEffectKey
    && fence.activityGeneration === submission.activationTarget.activityGeneration;

  if (!matchingFence) {
    const lawfulPreFenceGap = submission.origin.kind === 'runtime-effect'
      && submission.state.kind === 'queued'
      && attempt.effectState.kind === 'prepared'
      && attempt.turnBarrier.kind === 'reserved-pre-effect'
      && fence === undefined;
    if (!lawfulPreFenceGap) {
      return holdForRecovery(core, submission,
        'Run fence does not match the durable Terminal attempt',
        [submission.id, attempt.id, fence?.providerTurnSubmissionId ?? 'no-run-fence'], attempt);
    }
    const installed = await patchRun(core, run, {
      providerTurnOperationFence: {
        providerTurnId: submission.providerTurnId,
        providerTurnSubmissionId: submission.id,
        terminalInputAttemptId: attempt.id,
        commandClientOpId: deriveClientOpId(`agent.reconcileProviderTurn:${submission.id}`),
        submissionEffectKey: submission.submissionEffectKey,
        activityGeneration: submission.activationTarget.activityGeneration,
        acquiredAt: now(core),
        phase: 'terminal-prepared',
      },
    });
    if (!installed.ok) return installed;
    run = installed.value;
    fence = run.providerTurnOperationFence;
  }

  if (attempt.effectState.kind === 'prepared') {
    const logicalInput = storedSystemInput(submission);
    if (logicalInput === null) {
      return holdForRecovery(core, submission,
        'controller pre-effect input is replay-only and has no authenticated resumer',
        [submission.id, attempt.id], attempt);
    }
    if (digest(logicalInput) !== submission.inputDigest) {
      return holdForRecovery(core, submission,
        'Runtime system-input snapshot digest differs from its durable digest',
        [submission.id, attempt.id, submission.inputDigest], attempt);
    }
    if (submission.state.kind === 'queued') {
      const prepared = await patchSubmission(core, submission, {
        state: {
          kind: 'prepared', preparedAt: now(core),
          deliveryAttemptOrdinal: attempt.deliveryAttemptOrdinal,
          activation: { state: 'pending' },
        },
      });
      if (!prepared.ok) return prepared;
      submission = prepared.value;
    }
    if (run.providerTurnOperationFence?.phase !== 'submission-prepared') {
      const advanced = await patchRun(core, run, {
        providerTurnOperationFence: {
          ...run.providerTurnOperationFence!, phase: 'submission-prepared',
        },
      });
      if (!advanced.ok) return advanced;
      run = advanced.value;
    }
  }

  if (attempt.effectState.kind === 'prepared' || attempt.effectState.kind === 'executing') {
    const logicalInput = storedSystemInput(submission) ?? '';
    const executed = await core.terminal.executeProviderTurnInput({
      terminalInputAttemptId: attempt.id,
      expectedAttemptRecordVersion: attempt.recordVersion,
      submissionEffectKey: submission.submissionEffectKey,
      providerTurnId: submission.providerTurnId,
      activityGeneration: submission.activationTarget.activityGeneration,
      utf8Text: logicalInput,
    });
    if (!executed.ok) return executed;
    attempt = executed.value;
  }
  if (attempt.effectState.kind !== 'submitted-confirmed'
    && attempt.effectState.kind !== 'submitted-unconfirmed') {
    return holdForRecovery(core, submission,
      'Terminal attempt has no recoverable submitted disposition',
      [submission.id, attempt.id, attempt.effectState.kind], attempt);
  }

  const submissionState = attempt.effectState.kind === 'submitted-confirmed'
    ? {
        kind: 'submitted-confirmed' as const,
        terminalInputAttemptId: attempt.id,
        submittedAt: attempt.effectState.submittedAt,
        activation: { state: 'pending' as const },
      }
    : {
        kind: 'submitted-unconfirmed' as const,
        terminalInputAttemptId: attempt.id,
        submittedAt: attempt.effectState.submittedAt,
        uncertaintyReason: attempt.effectState.reason,
        activation: { state: 'pending' as const },
      };
  if (submission.state.kind !== 'submitted-confirmed'
    && submission.state.kind !== 'submitted-unconfirmed') {
    const patched = await patchSubmission(core, submission, { state: submissionState });
    if (!patched.ok) return patched;
    submission = patched.value;
  }

  runResult = await requireRun(core, submission.agentRunId);
  if (!runResult.ok) return runResult;
  run = runResult.value;
  const exactActive = run.activeProviderTurn?.providerTurnId === submission.providerTurnId
    && run.activeProviderTurn.activityGeneration === submission.activationTarget.activityGeneration
    && run.activityGeneration === submission.activationTarget.activityGeneration;
  if (!exactActive) {
    const mayActivate = run.activeProviderTurn === undefined
      && run.activityGeneration + 1 === submission.activationTarget.activityGeneration
      && run.providerTurnOperationFence?.providerTurnSubmissionId === submission.id;
    if (!mayActivate) {
      return holdForRecovery(core, submission,
        'Run activation target changed before recovery could commit it',
        [submission.id, attempt.id, String(run.activityGeneration)], attempt);
    }
    const activatedAt = now(core);
    const activated = await patchRun(core, run, {
      activity: 'working',
      activityGeneration: submission.activationTarget.activityGeneration,
      activeProviderTurn: {
        providerTurnId: submission.providerTurnId,
        activityGeneration: submission.activationTarget.activityGeneration,
        startedAt: activatedAt,
        state: 'working',
      },
      providerTurnOperationFence: {
        ...run.providerTurnOperationFence!, phase: 'active',
      },
    });
    if (!activated.ok) return activated;
    run = activated.value;
  } else if (run.providerTurnOperationFence?.phase !== 'active') {
    const activatedFence = await patchRun(core, run, {
      providerTurnOperationFence: {
        ...run.providerTurnOperationFence!, phase: 'active',
      },
    });
    if (!activatedFence.ok) return activatedFence;
    run = activatedFence.value;
  }

  const currentState = submission.state;
  if ((currentState.kind === 'submitted-confirmed'
      || currentState.kind === 'submitted-unconfirmed')
    && currentState.activation.state === 'pending') {
    const committed = await patchSubmission(core, submission, {
      state: {
        ...currentState,
        activation: {
          state: 'committed', committedRunRecordVersion: run.recordVersion,
          activatedAt: run.activeProviderTurn!.startedAt,
        },
      },
    });
    if (!committed.ok) return committed;
    submission = committed.value;
  }
  return b3ok(submission);
}

/** Owner-ordered recovery for every nonterminal submission, oldest first. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Owner-first reconciliation matrix is exhaustive.
export async function reconcileAllProviderTurnSubmissions(
  core: RunsCore,
  mode: 'startup' | 'periodic',
): Promise<B3Result<readonly ProviderTurnSubmissionId[]>> {
  const inventory = await core.store.list<ProviderTurnSubmission>('providerTurnSubmission');
  if (!inventory.ok) return inventory;
  const byId = new Map(inventory.value.map((submission) => [submission.id, submission]));
  const attempts = await core.terminal.listIncompleteProviderTurnInputAttempts({});
  if (!attempts.ok) return attempts;
  for (const attempt of attempts.value) {
    if (mode === 'periodic') {
      const runResult = await requireRun(core, attempt.agentRunId);
      if (!runResult.ok) return runResult;
      // A live command owns this Run until provisioning commits. Periodic
      // recovery must not race that owner through the same intermediate states;
      // startup recovery is different because the former owner is gone.
      if (runResult.value.lifecycle === 'provisioning') continue;
    }
    const submission = byId.get(attempt.providerTurnSubmissionId);
    const immutableMismatch = submission !== undefined
      && !attemptMatchesSubmission(attempt, submission);
    let executingMismatch = false;
    if (submission !== undefined && attempt.effectState.kind === 'executing') {
      const runResult = await requireRun(core, attempt.agentRunId);
      if (!runResult.ok) return runResult;
      const fence = runResult.value.providerTurnOperationFence;
      executingMismatch = submission.state.kind !== 'prepared'
        || fence?.providerTurnSubmissionId !== submission.id
        || fence.terminalInputAttemptId !== attempt.id
        || fence.phase !== 'submission-prepared';
    }
    if (submission !== undefined && !immutableMismatch && !executingMismatch) continue;
    const evidenceRefs = [
      attempt.id,
      attempt.providerTurnSubmissionId,
      submission === undefined ? 'runtime-submission-absent' : 'runtime-terminal-lineage-mismatch',
    ];
    const quarantined = await core.terminal.quarantineProviderTurnInputAttempt({
      terminalInputAttemptId: attempt.id,
      evidenceRefs,
    });
    if (!quarantined.ok) return quarantined;
    if (submission !== undefined) {
      const held = await holdForRecovery(core, submission,
        executingMismatch
          ? 'executing Terminal attempt lacks trace-complete Runtime prepared state/fence'
          : 'Terminal attempt immutable lineage differs from Runtime submission',
        evidenceRefs, attempt);
      if (!held.ok) return held;
      continue;
    }
    const runResult = await requireRun(core, attempt.agentRunId);
    if (runResult.ok) {
      const fence = runResult.value.providerTurnOperationFence;
      if (fence?.terminalInputAttemptId === attempt.id && fence.phase !== 'recovery-required') {
        const held = await patchRun(core, runResult.value, {
          providerTurnOperationFence: { ...fence, phase: 'recovery-required' },
        });
        if (!held.ok) return held;
      }
    }
  }

  const controller = await reconcileControllerPreEffectSubmissions(core, mode);
  if (!controller.ok) return controller;
  const reconciled = [...controller.value];
  const listed = await core.store.list<ProviderTurnSubmission>('providerTurnSubmission');
  if (!listed.ok) return listed;
  const terminalStates = new Set(['rejected', 'completion-unproven-final']);
  const submissions = listed.value
    .filter((item) => !terminalStates.has(item.state.kind))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt)
      || left.id.localeCompare(right.id));

  for (const initial of submissions) {
    let submission = initial;
    if (mode === 'periodic') {
      const runResult = await requireRun(core, submission.agentRunId);
      if (!runResult.ok) return runResult;
      if (runResult.value.lifecycle === 'provisioning') continue;
    }
    if (submission.state.kind === 'completed') {
      const runResult = await requireRun(core, submission.agentRunId);
      if (!runResult.ok) return runResult;
      const run = runResult.value;
      const fence = run.providerTurnOperationFence;
      if (fence?.providerTurnSubmissionId === submission.id) {
        const completed = run.lastCompletedProviderTurn;
        if (completed?.providerTurnId !== submission.providerTurnId
          || completed.transcriptTurnCompletionId
            !== submission.state.transcriptTurnCompletionId
          || completed.providerUsageEvidenceId !== submission.state.providerUsageEvidenceId
          || fence.phase !== 'completion-barrier-committed') {
          return operationConflict(submission,
            'completed submission does not match the Run completion/fence disposition');
        }
        const cleared = await patchRun(core, run, { providerTurnOperationFence: undefined });
        if (!cleared.ok) return cleared;
        reconciled.push(submission.id);
      }
      continue;
    }
    if (submission.state.kind === 'recovery-required') continue;
    const attemptResult = await core.terminal.getProviderTurnInputAttempt({
      terminalSessionId: submission.terminalSessionId,
      providerTurnId: submission.providerTurnId,
      submissionEffectKey: submission.submissionEffectKey,
    });
    if (!attemptResult.ok) return attemptResult;
    const attempt = attemptResult.value;
    if (attempt === null) {
      if (submission.origin.kind === 'runtime-effect' && submission.state.kind === 'queued') {
        const logicalInput = storedSystemInput(submission);
        if (logicalInput === null || digest(logicalInput) !== submission.inputDigest) {
          const held = await holdForRecovery(core, submission,
            'Runtime system-input snapshot is missing or corrupt',
            [submission.id, submission.inputDigest]);
          if (!held.ok) return held;
          reconciled.push(submission.id);
          continue;
        }
        const resumed = await submitProviderTurn(core, systemReplayContext(core, submission), {
          kind: 'runtime-effect',
          source: submission.origin.source,
          sourceEffectKey: submission.origin.sourceEffectKey,
          sourceObjectRef: submission.origin.sourceObjectRef,
          agentRunId: submission.agentRunId,
          terminalSessionId: submission.terminalSessionId,
          transcriptBindingId: submission.transcriptBindingId,
          utf8Text: logicalInput,
        });
        if (!resumed.ok) return resumed;
        submission = resumed.value.submission;
        reconciled.push(submission.id);
      } else if (submission.state.kind !== 'queued') {
        const held = await holdForRecovery(core, submission,
          'Runtime submission has no exact Terminal attempt', [submission.id]);
        if (!held.ok) return held;
        reconciled.push(submission.id);
        continue;
      } else {
        continue;
      }
    } else {
      const recovered = await recoverAttemptedSubmission(core, submission, attempt);
      if (!recovered.ok) return recovered;
      submission = recovered.value;
      reconciled.push(submission.id);
    }

    if ((submission.state.kind === 'submitted-confirmed'
        || submission.state.kind === 'submitted-unconfirmed')
      && submission.state.activation.state === 'committed'
      && core.providerTurnCompletionCoordinator !== undefined) {
      const coordinated = await core.providerTurnCompletionCoordinator({
        agentRunId: submission.agentRunId,
        providerTurnId: submission.providerTurnId,
        providerTurnSubmissionId: submission.id,
        activityGeneration: submission.activationTarget.activityGeneration,
        traceId: mintTraceCorrelationId(),
      });
      if (!coordinated.ok) return coordinated;
      if (coordinated.value.kind === 'completion-boundary-unproven'
        && !coordinated.value.retryable) {
        const held = await holdForRecovery(core, submission,
          coordinated.value.reason,
          coordinated.value.evidenceRefs,
          attempt ?? undefined);
        if (!held.ok) return held;
      }
    }
  }
  return b3ok([...new Set(reconciled)]);
}

const repairScope = 'agent.provider-turn.repair';

const evidenceUnion = (
  ...groups: readonly (readonly string[] | undefined)[]
): readonly string[] => [...new Set(groups.flatMap((group) => group ?? []))];

function terminalLiveness(status: Awaited<ReturnType<RunsCore['terminal']['getTerminal']>> extends
  B3Result<infer Value> ? Value : never): 'live' | 'unknown' | 'final' {
  if (status === null) return 'unknown';
  if (status.status === 'live') return 'live';
  return status.status === 'exited' || status.status === 'failed' ? 'final' : 'unknown';
}

/** Governed repair for a named unproven completion; it never invents completion. */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Dual-liveness closure preserves every refusal branch.
export async function closeProviderTurnCompletionUnproven(
  core: RunsCore,
  context: CommandContext,
  input: CloseProviderTurnCompletionUnprovenInput,
): Promise<B3Result<CloseProviderTurnCompletionUnprovenOutcome>> {
  if (context.principal.kind === 'system'
    || !context.principal.verifiedScopes.some((scope) => String(scope) === repairScope)) {
    return b3fail(b3err('PermissionDenied',
      'provider-turn repair requires a human/Operations principal with agent.provider-turn.repair', {
        principalId: context.principal.id, requiredScope: repairScope,
      }, false));
  }
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  const found = await getProviderTurnSubmission(core, input.providerTurnId);
  if (!found.ok) return found;
  let submission = found.value;
  if (submission.agentRunId !== input.agentRunId) {
    return operationConflict(submission, 'repair Run does not match the submission');
  }
  let runResult = await requireRun(core, input.agentRunId);
  if (!runResult.ok) return runResult;
  let run = runResult.value;

  if (submission.state.kind === 'completion-unproven-final') {
    if (run.lifecycle !== 'failed' || run.finalReason !== 'unrecoverable-failure') {
      return operationConflict(submission, 'unproven-final submission has no matching final Run');
    }
    return b3ok({
      kind: 'run-finalised-completion-unproven', agentRunId: run.id,
      providerTurnId: submission.providerTurnId, lifecycle: 'failed', activity: 'unknown',
      finalReason: 'unrecoverable-failure', completionClaimed: false,
    });
  }
  if (submission.state.kind === 'rejected') {
    return b3ok({
      kind: 'submission-rejected-no-effect', agentRunId: run.id,
      providerTurnId: submission.providerTurnId, submission,
      ...(submission.state.terminalInputAttemptId === undefined
        ? {} : { terminalInputAttemptId: submission.state.terminalInputAttemptId }),
      effectEscaped: false, terminalReservationCancelled: false,
      runFenceCleared: false, runActivityChanged: false, completionClaimed: false,
    });
  }
  if (submission.state.kind !== 'recovery-required') {
    return operationConflict(submission, 'repair requires a recovery-required submission');
  }
  const priorRecovery = submission.state;
  const expectedTuple = input.expectedActiveTuple;
  const attemptId = input.terminalInputAttemptId;
  const noEffectForm = expectedTuple === undefined;

  if (noEffectForm) {
    const attemptResult = await core.terminal.getProviderTurnInputAttempt({
      terminalSessionId: submission.terminalSessionId,
      providerTurnId: submission.providerTurnId,
      submissionEffectKey: submission.submissionEffectKey,
    });
    if (!attemptResult.ok) return attemptResult;
    const attempt = attemptResult.value;
    if (attemptId === undefined) {
      if (attempt !== null || priorRecovery.terminalInputAttemptId !== undefined
        || run.activeProviderTurn?.providerTurnId === submission.providerTurnId
        || run.providerTurnOperationFence?.providerTurnSubmissionId === submission.id) {
        return operationConflict(submission,
          'no-attempt repair could not prove the absence of an attempt, active tuple, and fence');
      }
      const rejected = await patchSubmission(core, submission, {
        state: {
          kind: 'rejected', rejectedAt: now(core), reason: input.reason,
          effectEscaped: false,
          evidenceRefs: evidenceUnion(priorRecovery.evidenceRefs, input.completionEvidenceRefs),
        },
      });
      if (!rejected.ok) return rejected;
      return b3ok({
        kind: 'submission-rejected-no-effect', agentRunId: run.id,
        providerTurnId: submission.providerTurnId, submission: rejected.value,
        effectEscaped: false, terminalReservationCancelled: false,
        runFenceCleared: false, runActivityChanged: false, completionClaimed: false,
      });
    }
    if (attempt === null || attempt.id !== attemptId
      || priorRecovery.terminalInputAttemptId !== attemptId
      || !attemptMatchesSubmission(attempt, submission)
      || run.activeProviderTurn?.providerTurnId === submission.providerTurnId) {
      return operationConflict(submission, 'pre-effect repair tuple does not match owner facts');
    }
    const prepared = attempt.effectState.kind === 'prepared'
      && attempt.turnBarrier.kind === 'reserved-pre-effect';
    const alreadyRejected = attempt.effectState.kind === 'rejected'
      && attempt.turnBarrier.kind === 'released-rejected';
    if (!prepared && !alreadyRejected) {
      return operationConflict(submission, 'attempt may have crossed the provider-effect boundary');
    }
    const fence = run.providerTurnOperationFence;
    if (fence !== undefined && (fence.providerTurnSubmissionId !== submission.id
      || fence.terminalInputAttemptId !== attempt.id
      || !['terminal-prepared', 'submission-prepared', 'recovery-required'].includes(fence.phase))) {
      return operationConflict(submission, 'pre-effect Run fence differs from the repair tuple');
    }
    let terminalReservationCancelled = false;
    if (prepared) {
      const cancelled = await core.terminal.cancelPreparedProviderTurnInput({
        terminalInputAttemptId: attempt.id,
        expectedAttemptRecordVersion: attempt.recordVersion,
        reason: 'runtime-preparation-rejected',
      });
      if (!cancelled.ok) return cancelled;
      terminalReservationCancelled = true;
    }
    let runFenceCleared = false;
    if (fence !== undefined) {
      const cleared = await patchRun(core, run, { providerTurnOperationFence: undefined });
      if (!cleared.ok) return cleared;
      run = cleared.value;
      runFenceCleared = true;
    }
    const rejected = await patchSubmission(core, submission, {
      state: {
        kind: 'rejected', rejectedAt: now(core), terminalInputAttemptId: attempt.id,
        reason: input.reason, effectEscaped: false,
        evidenceRefs: evidenceUnion(priorRecovery.evidenceRefs,
          input.completionEvidenceRefs, [attempt.id]),
      },
    });
    if (!rejected.ok) return rejected;
    return b3ok({
      kind: 'submission-rejected-no-effect', agentRunId: run.id,
      providerTurnId: submission.providerTurnId, submission: rejected.value,
      terminalInputAttemptId: attempt.id, effectEscaped: false,
      terminalReservationCancelled, runFenceCleared,
      runActivityChanged: false, completionClaimed: false,
    });
  }

  if (attemptId === undefined
    || expectedTuple.providerTurnId !== submission.providerTurnId
    || expectedTuple.activityGeneration !== submission.activationTarget.activityGeneration
    || priorRecovery.terminalInputAttemptId !== attemptId
    || (priorRecovery.lastSafeState !== 'submitted-confirmed'
      && priorRecovery.lastSafeState !== 'submitted-unconfirmed')) {
    return operationConflict(submission, 'activated repair requires the exact attempt and active tuple');
  }
  const attemptResult = await core.terminal.getProviderTurnInputAttempt({
    terminalSessionId: submission.terminalSessionId,
    providerTurnId: submission.providerTurnId,
    submissionEffectKey: submission.submissionEffectKey,
  });
  if (!attemptResult.ok) return attemptResult;
  const attempt = attemptResult.value;
  if (attempt === null || attempt.id !== attemptId || !attemptMatchesSubmission(attempt, submission)) {
    return operationConflict(submission, 'activated repair Terminal attempt differs');
  }

  // Resume after the Terminal barrier commit without advancing generation a
  // second time: the still-active Run is the durable indication that step 2
  // below has not committed yet.
  const alreadyClosed = attempt.turnBarrier.kind === 'closed-unproven';
  if (!alreadyClosed && attempt.turnBarrier.kind !== 'active'
    && attempt.turnBarrier.kind !== 'interrupt-committed') {
    return operationConflict(submission, 'Terminal barrier is not eligible for unproven closure');
  }
  if (run.lifecycle === 'failed' && run.finalReason === 'unrecoverable-failure'
    && alreadyClosed) {
    const closed = await patchSubmission(core, submission, {
      state: {
        kind: 'completion-unproven-final', terminalInputAttemptId: attempt.id,
        closedAt: now(core), reason: input.reason,
        evidenceRefs: evidenceUnion(priorRecovery.evidenceRefs,
          input.completionEvidenceRefs, [attempt.id]),
        runFinalReason: 'unrecoverable-failure',
      },
    });
    if (!closed.ok) return closed;
    return b3ok({
      kind: 'run-finalised-completion-unproven', agentRunId: run.id,
      providerTurnId: submission.providerTurnId, lifecycle: 'failed', activity: 'unknown',
      finalReason: 'unrecoverable-failure', completionClaimed: false,
    });
  }
  if (run.activeProviderTurn?.providerTurnId !== submission.providerTurnId
    || run.activeProviderTurn.activityGeneration !== expectedTuple.activityGeneration
    || run.activityGeneration !== expectedTuple.activityGeneration
    || run.providerTurnOperationFence?.providerTurnSubmissionId !== submission.id
    || run.providerTurnOperationFence.phase !== 'recovery-required') {
    return operationConflict(submission, 'Run active tuple/fence differs from the repair tuple');
  }

  const terminal = await core.terminal.getTerminal(context.principal, submission.terminalSessionId);
  if (!terminal.ok) return terminal;
  const terminalState = terminalLiveness(terminal.value);
  const providerSession = await core.agents.getProviderSession(
    context.principal, submission.providerSessionId,
  );
  if (!providerSession.ok) return providerSession;
  const provider = await core.providers.probeSessionLiveness({
    provider: providerSession.value.provider,
    providerSessionId: submission.providerSessionId,
    providerNativeSessionId: providerSession.value.providerNativeSessionId,
  });
  if (!provider.ok) return provider;
  if (terminalState !== 'final' || provider.value.liveness !== 'final') {
    return b3ok({
      kind: 'provider-still-live-or-unknown', terminalLiveness: terminalState,
      providerLiveness: provider.value.liveness, bothFinal: false,
      retryable: true, runChanged: false,
    });
  }
  if (!alreadyClosed) {
    const terminalClosed = await core.terminal.closeProviderTurnBarrierUnproven({
      terminalInputAttemptId: attempt.id,
      agentRunId: submission.agentRunId,
      providerTurnId: submission.providerTurnId,
      activityGeneration: expectedTuple.activityGeneration,
      terminalFinalEvidenceRefs: [
        `terminal:${submission.terminalSessionId}:final`,
        ...input.completionEvidenceRefs,
      ],
    });
    if (!terminalClosed.ok) return terminalClosed;
  }
  const finalAt = now(core);
  const finalRun = await patchRun(core, run, {
    lifecycle: 'failed', activity: 'unknown',
    activityGeneration: (run.activityGeneration + 1) as ActivityGeneration,
    activeProviderTurn: undefined, providerTurnOperationFence: undefined,
    finalAt, finalReason: 'unrecoverable-failure',
  });
  if (!finalRun.ok) return finalRun;
  run = finalRun.value;
  const closed = await patchSubmission(core, submission, {
    state: {
      kind: 'completion-unproven-final', terminalInputAttemptId: attempt.id,
      closedAt: finalAt, reason: input.reason,
      evidenceRefs: evidenceUnion(priorRecovery.evidenceRefs,
        input.completionEvidenceRefs, provider.value.evidenceRefs,
        [attempt.id, `terminal:${submission.terminalSessionId}:final`]),
      runFinalReason: 'unrecoverable-failure',
    },
  });
  if (!closed.ok) return closed;
  submission = closed.value;
  core.publish('agent.run.provider-turn.completion-unproven', {
    agentRunId: run.id, providerTurnId: submission.providerTurnId,
    providerTurnSubmissionId: submission.id,
    activityGeneration: run.activityGeneration,
    completionClaimed: false,
  }, context.traceId);
  return b3ok({
    kind: 'run-finalised-completion-unproven', agentRunId: run.id,
    providerTurnId: submission.providerTurnId, lifecycle: 'failed', activity: 'unknown',
    finalReason: 'unrecoverable-failure', completionClaimed: false,
  });
}

const sameCompletion = (
  run: AgentRun,
  input: CompleteProviderTurnInput,
): boolean => run.lastCompletedProviderTurn?.providerTurnId === input.providerTurnId
  && run.lastCompletedProviderTurn.transcriptTurnCompletionId
    === input.transcriptTurnCompletionId
  && run.lastCompletedProviderTurn.providerUsageEvidenceId === input.providerUsageEvidenceId;

const targetChanged = (
  run: AgentRun,
  input: CompleteProviderTurnInput,
): B3Result<CompleteProviderTurnOutcome> => b3ok({
  kind: 'target-changed',
  expectedTuple: input.expectedActiveTuple,
  actualTuple: {
    ...(run.activeProviderTurn === undefined
      ? {}
      : { providerTurnId: run.activeProviderTurn.providerTurnId }),
    activityGeneration: run.activityGeneration,
  },
  inputLeaseChanged: false,
  retryable: false,
});

function lineageMismatch(
  owner: 'runtime' | 'transcript' | 'agents',
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string | null>>,
): B3Result<CompleteProviderTurnOutcome> {
  return b3ok({ kind: 'lineage-evidence-mismatch', owner, expected, actual, retryable: false });
}

/**
 * The sole activity-completion mutation. Transcript proves the provider end,
 * Agents attests that exact immutable fact, and Terminal orders completion
 * against interrupt before Runtime moves generation.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Sole completion CAS keeps lineage checks explicit.
export async function completeProviderTurn(
  core: RunsCore,
  context: CommandContext,
  input: CompleteProviderTurnInput,
): Promise<B3Result<CompleteProviderTurnOutcome>> {
  if (context.principal.id !== 'sys_reconciler') {
    return b3fail(b3err('PermissionDenied',
      'provider-turn completion requires sys_reconciler', {
        principalId: context.principal.id,
      }, false));
  }
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;

  const submissionResult = await getProviderTurnSubmission(core, input.providerTurnId);
  if (!submissionResult.ok) return submissionResult;
  let submission = submissionResult.value;
  if (submission.agentRunId !== input.agentRunId) {
    return lineageMismatch('runtime', {
      agentRunId: String(input.agentRunId), providerTurnId: String(input.providerTurnId),
    }, {
      agentRunId: String(submission.agentRunId), providerTurnId: String(submission.providerTurnId),
    });
  }

  const runResult = await requireRun(core, input.agentRunId);
  if (!runResult.ok) return runResult;
  let run = runResult.value;
  if (sameCompletion(run, input)) {
    const original = completedOutcome(run)!;
    if (submission.state.kind !== 'completed') {
      const completed = run.lastCompletedProviderTurn!;
      const priorState = submission.state;
      if (priorState.kind !== 'submitted-confirmed' && priorState.kind !== 'submitted-unconfirmed') {
        return operationConflict(submission,
          'Run records completion but the submission has no submitted disposition');
      }
      const repaired = await patchSubmission(core, submission, {
        state: {
          kind: 'completed',
          terminalInputAttemptId: completed.terminalInputAttemptId,
          submissionDisposition: priorState.kind,
          activationActivityGeneration: completed.activationActivityGeneration,
          completionActivityGeneration: completed.completionActivityGeneration,
          transcriptTurnCompletionId: completed.transcriptTurnCompletionId,
          providerUsageEvidenceId: completed.providerUsageEvidenceId,
          terminalAttemptRecordVersion: completed.terminalAttemptRecordVersion,
          interruptDisposition: completed.interruptDisposition,
          completedRunRecordVersion: run.recordVersion,
          completedAt: completed.completedAt,
        },
      });
      if (!repaired.ok) return repaired;
      submission = repaired.value;
    }
    if (run.providerTurnOperationFence?.providerTurnId === input.providerTurnId) {
      const cleared = await patchRun(core, run, { providerTurnOperationFence: undefined });
      if (!cleared.ok) return cleared;
      run = cleared.value;
    }
    return b3ok({ kind: 'already-completed-by-same-evidence', original });
  }
  if (FINAL_LIFECYCLES.has(run.lifecycle)) {
    return b3ok({
      kind: 'run-final', agentRunId: run.id,
      lifecycle: run.lifecycle as 'stopped' | 'failed' | 'interrupted', retryable: false,
    });
  }

  const owners = core.providerTurnCompletionEvidence;
  if (owners === undefined) {
    return b3ok({
      kind: 'evidence-not-yet-available', missing: ['transcript', 'agents'], retryable: true,
    });
  }
  const [transcriptResult, usageResult] = await Promise.all([
    owners.getTranscriptCompletion(input.transcriptTurnCompletionId),
    owners.getUsageEvidence(input.providerUsageEvidenceId),
  ]);
  const missing: Array<'transcript' | 'agents'> = [];
  if (!transcriptResult.ok && transcriptResult.error.retryable) missing.push('transcript');
  if (!usageResult.ok && usageResult.error.retryable) missing.push('agents');
  if (missing.length > 0) {
    return b3ok({ kind: 'evidence-not-yet-available', missing, retryable: true });
  }
  if (!transcriptResult.ok) return transcriptResult;
  if (!usageResult.ok) return usageResult;
  const completion = transcriptResult.value;
  const evidence = usageResult.value;

  const transcriptExpected = {
    transcriptTurnCompletionId: String(input.transcriptTurnCompletionId),
    providerTurnId: String(submission.providerTurnId),
    agentRunId: String(submission.agentRunId),
    providerSessionId: String(submission.providerSessionId),
    providerConversationId: submission.providerConversationId ?? '',
    transcriptBindingId: String(submission.transcriptBindingId),
  };
  const transcriptActual = {
    transcriptTurnCompletionId: String(completion.id),
    providerTurnId: String(completion.providerTurnId),
    agentRunId: String(completion.agentRunId),
    providerSessionId: String(completion.providerSessionId),
    providerConversationId: completion.providerConversationId,
    transcriptBindingId: String(completion.transcriptBindingId),
  };
  if (transcriptExpected.transcriptTurnCompletionId !== transcriptActual.transcriptTurnCompletionId
    || transcriptExpected.providerTurnId !== transcriptActual.providerTurnId
    || transcriptExpected.agentRunId !== transcriptActual.agentRunId
    || transcriptExpected.providerSessionId !== transcriptActual.providerSessionId
    || transcriptExpected.providerConversationId !== (transcriptActual.providerConversationId ?? '')
    || transcriptExpected.transcriptBindingId !== transcriptActual.transcriptBindingId) {
    return lineageMismatch('transcript', transcriptExpected, transcriptActual);
  }
  const evidenceScope = evidence.scope.kind === 'runtime-turn-completion'
    ? evidence.scope : null;
  const agentsExpected = {
    providerUsageEvidenceId: String(input.providerUsageEvidenceId),
    providerSessionId: String(submission.providerSessionId),
    providerConversationId: submission.providerConversationId ?? '',
    agentRunId: String(submission.agentRunId),
    providerTurnId: String(submission.providerTurnId),
    transcriptTurnCompletionId: String(completion.id),
    sourceCursor: completion.completionTranscriptWatermark,
    evidenceDigest: completion.completionEvidenceDigest,
  };
  const agentsActual = {
    providerUsageEvidenceId: String(evidence.id),
    providerSessionId: String(evidence.providerSessionId),
    providerConversationId: evidence.providerConversationId,
    agentRunId: evidenceScope === null ? null : String(evidenceScope.agentRunId),
    providerTurnId: evidenceScope === null ? null : String(evidenceScope.providerTurnId),
    transcriptTurnCompletionId: evidenceScope === null
      ? null : String(evidenceScope.transcriptTurnCompletionId),
    sourceCursor: evidence.sourceCursor ?? null,
    evidenceDigest: evidence.measurement.evidenceDigest,
  };
  if (agentsExpected.providerUsageEvidenceId !== agentsActual.providerUsageEvidenceId
    || agentsExpected.providerSessionId !== agentsActual.providerSessionId
    || agentsExpected.providerConversationId !== (agentsActual.providerConversationId ?? '')
    || agentsExpected.agentRunId !== agentsActual.agentRunId
    || agentsExpected.providerTurnId !== agentsActual.providerTurnId
    || agentsExpected.transcriptTurnCompletionId !== agentsActual.transcriptTurnCompletionId
    || agentsExpected.sourceCursor !== agentsActual.sourceCursor
    || agentsExpected.evidenceDigest !== agentsActual.evidenceDigest
    || evidence.source !== 'transcript-turn-completion'
    || evidence.observedAt !== completion.observedAt
    || evidence.measurement.quality !== 'partial'
    || evidence.measurement.providerTurns !== 1) {
    return lineageMismatch('agents', agentsExpected, agentsActual);
  }

  if (input.expectedActiveTuple.providerTurnId !== input.providerTurnId
    || run.activeProviderTurn?.providerTurnId !== input.providerTurnId
    || run.activeProviderTurn.activityGeneration !== input.expectedActiveTuple.activityGeneration
    || run.activityGeneration !== input.expectedActiveTuple.activityGeneration) {
    return targetChanged(run, input);
  }
  const fence = run.providerTurnOperationFence;
  if (fence === undefined
    || fence.providerTurnId !== input.providerTurnId
    || fence.providerTurnSubmissionId !== submission.id
    || fence.activityGeneration !== input.expectedActiveTuple.activityGeneration) {
    return targetChanged(run, input);
  }
  if (submission.state.kind !== 'submitted-confirmed'
    && submission.state.kind !== 'submitted-unconfirmed') {
    return operationConflict(submission, 'completion requires a submitted disposition');
  }
  const submittedState = submission.state;
  if (fence.phase !== 'completing' && fence.phase !== 'completion-barrier-committed') {
    const completing = await patchRun(core, run, {
      providerTurnOperationFence: { ...fence, phase: 'completing' },
    });
    if (!completing.ok) return completing;
    run = completing.value;
  }

  const settled = await core.terminal.settleProviderTurnCompletion({
    terminalInputAttemptId: submittedState.terminalInputAttemptId,
    agentRunId: run.id,
    providerTurnId: input.providerTurnId,
    activityGeneration: input.expectedActiveTuple.activityGeneration,
    transcriptTurnCompletionId: input.transcriptTurnCompletionId,
    providerUsageEvidenceId: input.providerUsageEvidenceId,
  });
  if (!settled.ok) return settled;
  if (settled.value.kind === 'target-turn-not-active') return targetChanged(run, input);

  const refreshed = await requireRun(core, run.id);
  if (!refreshed.ok) return refreshed;
  run = refreshed.value;
  if (run.activeProviderTurn?.providerTurnId !== input.providerTurnId
    || run.activityGeneration !== input.expectedActiveTuple.activityGeneration
    || run.providerTurnOperationFence?.terminalInputAttemptId
      !== submittedState.terminalInputAttemptId) {
    return targetChanged(run, input);
  }
  const completedAt = now(core);
  const completionActivityGeneration = (run.activityGeneration + 1) as ActivityGeneration;
  const disposition = {
    providerTurnId: input.providerTurnId,
    activationActivityGeneration: input.expectedActiveTuple.activityGeneration,
    completionActivityGeneration,
    transcriptTurnCompletionId: input.transcriptTurnCompletionId,
    providerUsageEvidenceId: input.providerUsageEvidenceId,
    terminalInputAttemptId: submittedState.terminalInputAttemptId,
    terminalAttemptRecordVersion: settled.value.attemptRecordVersion,
    interruptDisposition: settled.value.interruptDisposition,
    completedAt,
  };
  const completedRun = await patchRun(core, run, {
    activity: 'idle',
    activityGeneration: completionActivityGeneration,
    activeProviderTurn: undefined,
    lastCompletedProviderTurn: disposition,
    providerTurnOperationFence: {
      ...run.providerTurnOperationFence!, phase: 'completion-barrier-committed',
    },
  });
  if (!completedRun.ok) return completedRun;
  run = completedRun.value;
  const completedSubmission = await patchSubmission(core, submission, {
    state: {
      kind: 'completed',
      terminalInputAttemptId: submittedState.terminalInputAttemptId,
      submissionDisposition: submittedState.kind,
      activationActivityGeneration: input.expectedActiveTuple.activityGeneration,
      completionActivityGeneration,
      transcriptTurnCompletionId: input.transcriptTurnCompletionId,
      providerUsageEvidenceId: input.providerUsageEvidenceId,
      terminalAttemptRecordVersion: settled.value.attemptRecordVersion,
      interruptDisposition: settled.value.interruptDisposition,
      completedRunRecordVersion: run.recordVersion,
      completedAt,
    },
  });
  if (!completedSubmission.ok) return completedSubmission;
  submission = completedSubmission.value;
  const cleared = await patchRun(core, run, { providerTurnOperationFence: undefined });
  if (!cleared.ok) return cleared;
  core.publish('agent.run.provider-turn.completed', {
    agentRunId: run.id,
    providerTurnId: input.providerTurnId,
    providerTurnSubmissionId: submission.id,
    activationActivityGeneration: input.expectedActiveTuple.activityGeneration,
    completionActivityGeneration,
    transcriptTurnCompletionId: input.transcriptTurnCompletionId,
    providerUsageEvidenceId: input.providerUsageEvidenceId,
    interruptDisposition: settled.value.interruptDisposition,
  }, context.traceId);
  return b3ok({ kind: 'completed', agentRunId: run.id, ...disposition });
}

export function completedOutcome(
  run: AgentRun,
): CompletedProviderTurnOutcome | null {
  const completed = run.lastCompletedProviderTurn;
  return completed === undefined ? null : {
    kind: 'completed',
    agentRunId: run.id,
    providerTurnId: completed.providerTurnId,
    activationActivityGeneration: completed.activationActivityGeneration,
    completionActivityGeneration: completed.completionActivityGeneration,
    transcriptTurnCompletionId: completed.transcriptTurnCompletionId,
    providerUsageEvidenceId: completed.providerUsageEvidenceId,
    terminalInputAttemptId: completed.terminalInputAttemptId,
    terminalAttemptRecordVersion: completed.terminalAttemptRecordVersion,
    interruptDisposition: completed.interruptDisposition,
  };
}

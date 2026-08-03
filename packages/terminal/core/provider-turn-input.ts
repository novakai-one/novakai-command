/* eslint-disable max-lines -- Terminal owns the complete prepare/execute/barrier state machine. */

import { createHash } from 'node:crypto';
import {
  b3err,
  b3fail,
  b3ok,
  keysetPage,
  mintClientOpId,
  mintTerminalInputAttemptId,
  type B3Page,
  type B3Result,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  CancelPreparedProviderTurnInput,
  CloseTerminalProviderTurnUnprovenInput,
  ExecuteProviderTurnInputInput,
  GetProviderTurnInputAttemptInput,
  IncompleteProviderTurnInputAttemptFilter,
  PrepareProviderTurnInputInput,
  PrepareProviderTurnInputOutcome,
  SettleTerminalProviderTurnCompletionInput,
  SettleTerminalProviderTurnCompletionOutcome,
} from '../contract/api.js';
import type {
  ControllerAttachment,
  ProviderTurnTerminalInputAttempt,
} from '../contract/records.js';
import { settleAndFindActive } from './leases.js';
import {
  clockIso, publishProviderTurnBarrier, requireLiveSession, type TerminalCore,
} from './context.js';
import type { Persisted } from './store.js';

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const conflict = (message: string, details: Readonly<Record<string, unknown>>) =>
  b3fail(b3err('ProviderTurnSubmissionConflict', message, details, false));

function attemptTerminal(attempt: ProviderTurnTerminalInputAttempt): boolean {
  return attempt.turnBarrier.kind === 'completion-committed'
    || attempt.turnBarrier.kind === 'closed-unproven'
    || attempt.turnBarrier.kind === 'released-rejected';
}

function interruptBarrier(
  barrier: Extract<ProviderTurnTerminalInputAttempt['turnBarrier'], { readonly kind: 'interrupt-committed' }>,
) {
  return {
    barrierCommittedAt: barrier.barrierCommittedAt,
    ...(barrier.revokedLeaseGeneration === undefined
      ? {}
      : { revokedLeaseGeneration: barrier.revokedLeaseGeneration }),
    newLeaseGeneration: barrier.newLeaseGeneration,
  };
}

export async function listProviderTurnAttempts(
  core: TerminalCore,
  filter: { readonly terminalSessionId?: string; readonly agentRunId?: string } = {},
): Promise<B3Result<readonly ProviderTurnTerminalInputAttempt[]>> {
  const listed = await core.store.list<ProviderTurnTerminalInputAttempt>(
    'terminalInputAttempt',
    filter as Record<string, unknown>,
  );
  if (!listed.ok) return listed;
  return b3ok(listed.value.filter((attempt) => attempt.source === 'provider-turn'));
}

export async function activeProviderTurnAttempt(
  core: TerminalCore,
  terminalSessionId: ProviderTurnTerminalInputAttempt['terminalSessionId'],
): Promise<B3Result<ProviderTurnTerminalInputAttempt | null>> {
  const attempts = await listProviderTurnAttempts(core, { terminalSessionId });
  if (!attempts.ok) return attempts;
  return b3ok(attempts.value.find((attempt) => !attemptTerminal(attempt)) ?? null);
}

async function exactAttempt(
  core: TerminalCore,
  id: string,
): Promise<B3Result<ProviderTurnTerminalInputAttempt | null>> {
  const found = await core.store.read<ProviderTurnTerminalInputAttempt>('terminalInputAttempt', id);
  if (!found.ok || found.value === null) return found;
  return found.value.source === 'provider-turn' ? found : b3ok(null);
}

async function conflictingAttempt(
  core: TerminalCore,
  input: Pick<PrepareProviderTurnInputInput, 'terminalSessionId' | 'providerTurnId' | 'submissionEffectKey'>,
): Promise<B3Result<ProviderTurnTerminalInputAttempt | null>> {
  const listed = await listProviderTurnAttempts(core, { terminalSessionId: input.terminalSessionId });
  if (!listed.ok) return listed;
  return b3ok(listed.value.find((attempt) =>
    !attemptTerminal(attempt)
    && (attempt.providerTurnId !== input.providerTurnId
      || attempt.submissionEffectKey !== input.submissionEffectKey)) ?? null);
}

async function priorAttempt(
  core: TerminalCore,
  input: PrepareProviderTurnInputInput,
): Promise<B3Result<ProviderTurnTerminalInputAttempt | null>> {
  const listed = await listProviderTurnAttempts(core, { terminalSessionId: input.terminalSessionId });
  if (!listed.ok) return listed;
  return b3ok(listed.value.find((attempt) =>
    attempt.providerTurnSubmissionId === input.providerTurnSubmissionId
    && attempt.deliveryAttemptOrdinal === input.deliveryAttemptOrdinal
    && attempt.providerTurnId === input.providerTurnId
    && attempt.submissionEffectKey === input.submissionEffectKey) ?? null);
}

async function controllerAuthority(
  core: TerminalCore,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: PrepareProviderTurnInputInput & { readonly authority: Extract<
    PrepareProviderTurnInputInput['authority'], { readonly kind: 'controller' }
  > },
): Promise<B3Result<ProviderTurnTerminalInputAttempt['authority']>> {
  void context;
  const attachment = await core.store.read<ControllerAttachment>(
    'controllerAttachment', input.authority.attachmentId,
  );
  if (!attachment.ok) return attachment;
  if (attachment.value === null
    || attachment.value.terminalSessionId !== input.terminalSessionId
    || attachment.value.state !== 'attached'
    || attachment.value.principalId !== input.authority.requestingPrincipalId) {
    return conflict('controller attachment authority does not match the terminal', {
      terminalSessionId: input.terminalSessionId,
      attachmentId: input.authority.attachmentId,
    });
  }
  const held = await settleAndFindActive(core, input.terminalSessionId);
  if (!held.ok) return held;
  if (held.value === null
    || held.value.id !== input.authority.inputLeaseId
    || held.value.attachmentId !== input.authority.attachmentId
    || held.value.generation !== input.authority.leaseGeneration) {
    return conflict('controller input lease no longer matches', {
      terminalSessionId: input.terminalSessionId,
      inputLeaseId: input.authority.inputLeaseId,
    });
  }
  const live = core.live.lookup(input.terminalSessionId);
  if (live === undefined || live.nextInputSequence !== input.authority.expectedNextInputSequence) {
    return conflict('controller input sequence changed before preparation', {
      expected: input.authority.expectedNextInputSequence,
      actual: live?.nextInputSequence ?? null,
    });
  }
  return b3ok({
    kind: 'controller',
    attachmentId: input.authority.attachmentId,
    inputLeaseId: input.authority.inputLeaseId,
    leaseGeneration: input.authority.leaseGeneration,
    resumeDeadlineAt: held.value.expiresAt,
    requestingPrincipalId: input.authority.requestingPrincipalId,
  });
}

async function runtimeAuthority(
  core: TerminalCore,
  input: PrepareProviderTurnInputInput & { readonly authority: Extract<
    PrepareProviderTurnInputInput['authority'], { readonly kind: 'runtime-safe-boundary' }
  > },
): Promise<B3Result<
  | ProviderTurnTerminalInputAttempt['authority']
  | Extract<PrepareProviderTurnInputOutcome, { readonly kind: 'not-yet-safe' }>
>> {
  const held = await settleAndFindActive(core, input.terminalSessionId);
  if (!held.ok) return held;
  if (held.value !== null) {
    return b3ok({
      kind: 'not-yet-safe',
      blocking: { kind: 'active-input-lease', leaseId: held.value.id },
      retryable: true,
      attemptCreated: false,
      inputChanged: false,
    });
  }
  const attachments = await core.store.list<ControllerAttachment>(
    'controllerAttachment', { terminalSessionId: input.terminalSessionId },
  );
  if (!attachments.ok) return attachments;
  if (attachments.value.some((item) => item.state === 'attached' && item.draftState === 'present')) {
    return b3ok({
      kind: 'not-yet-safe',
      blocking: { kind: 'controller-draft' },
      retryable: true,
      attemptCreated: false,
      inputChanged: false,
    });
  }
  return b3ok({ ...input.authority });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Explicit pre-effect authority matrix.
export async function prepareProviderTurnInput(
  core: TerminalCore,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: PrepareProviderTurnInputInput,
): Promise<B3Result<PrepareProviderTurnInputOutcome>> {
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  if (digest(input.utf8Text) !== input.inputDigest) {
    return conflict('provider-turn preparation input digest does not match', {
      providerTurnSubmissionId: input.providerTurnSubmissionId,
    });
  }
  const prior = await priorAttempt(core, input);
  if (!prior.ok) return prior;
  if (prior.value !== null) return b3ok({ kind: 'prepared', attempt: prior.value });
  const competing = await conflictingAttempt(core, input);
  if (!competing.ok) return competing;
  if (competing.value !== null) {
    return b3ok({
      kind: 'not-yet-safe',
      blocking: { kind: 'active-provider-turn' },
      retryable: true,
      attemptCreated: false,
      inputChanged: false,
    });
  }
  const authority = input.authority.kind === 'controller'
    ? await controllerAuthority(core, context, { ...input, authority: input.authority })
    : await runtimeAuthority(core, { ...input, authority: input.authority });
  if (!authority.ok) return authority;
  if ('retryable' in authority.value) return b3ok(authority.value);
  const live = core.live.lookup(input.terminalSessionId);
  if (live === undefined) {
    return b3fail(b3err('TerminalNotLive', 'no live provider process', {
      terminalSessionId: input.terminalSessionId,
    }, false));
  }
  const observedAt = clockIso(core);
  const record: Persisted<ProviderTurnTerminalInputAttempt> = {
    kind: 'terminalInputAttempt',
    id: mintTerminalInputAttemptId(),
    schemaVersion: 1,
    createdAt: observedAt,
    permissionLevel: 'private',
    createdBy: 'sys_terminal',
    source: 'provider-turn',
    terminalSessionId: input.terminalSessionId,
    inputSequence: live.nextInputSequence,
    payloadDigest: input.inputDigest,
    kindOfInput: 'provider-turn-submit',
    agentRunId: input.agentRunId,
    providerTurnSubmissionId: input.providerTurnSubmissionId,
    deliveryAttemptOrdinal: input.deliveryAttemptOrdinal,
    providerTurnId: input.providerTurnId,
    activityGeneration: input.activityGeneration,
    submissionEffectKey: input.submissionEffectKey,
    providerSessionId: input.providerSessionId,
    transcriptBindingId: input.transcriptBindingId,
    startTranscriptWatermark: input.startTranscriptWatermark,
    expectedRunRecordVersion: input.expectedRunRecordVersion,
    authority: authority.value,
    effectState: { kind: 'prepared', preparedAt: observedAt },
    turnBarrier: { kind: 'reserved-pre-effect' },
  };
  const written = await core.store.create<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', record, mintClientOpId(),
  );
  if (!written.ok) return written;
  publishProviderTurnBarrier(core, written.value);
  return b3ok({ kind: 'prepared', attempt: written.value });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Durable write/effect uncertainty cuts are explicit.
export async function executeProviderTurnInput(
  core: TerminalCore,
  input: ExecuteProviderTurnInputInput,
): Promise<B3Result<ProviderTurnTerminalInputAttempt>> {
  const found = await exactAttempt(core, input.terminalInputAttemptId);
  if (!found.ok) return found;
  if (found.value === null) return conflict('unknown provider-turn input attempt', {
    terminalInputAttemptId: input.terminalInputAttemptId,
  });
  let attempt = found.value;
  if (attempt.providerTurnId !== input.providerTurnId
    || attempt.submissionEffectKey !== input.submissionEffectKey
    || attempt.activityGeneration !== input.activityGeneration) {
    return conflict('provider-turn execute tuple does not match preparation', {
      terminalInputAttemptId: input.terminalInputAttemptId,
    });
  }
  if (attempt.effectState.kind === 'submitted-confirmed'
    || attempt.effectState.kind === 'submitted-unconfirmed') return b3ok(attempt);
  if (attempt.effectState.kind === 'executing') {
    const recovered = await core.store.update<ProviderTurnTerminalInputAttempt>(
      'sys_terminal', 'terminalInputAttempt', attempt.id,
      {
        effectState: {
          kind: 'submitted-unconfirmed',
          submittedAt: clockIso(core),
          reason: 'execution outcome was lost after the pre-effect fence',
        },
        turnBarrier: { kind: 'active', activatedAt: clockIso(core) },
      },
      attempt.recordVersion,
      mintClientOpId(),
    );
    if (recovered.ok) publishProviderTurnBarrier(core, recovered.value);
    return recovered;
  }
  if (attempt.payloadDigest !== digest(input.utf8Text)) {
    return conflict('provider-turn execute digest does not match preparation', {
      terminalInputAttemptId: input.terminalInputAttemptId,
    });
  }
  if (attempt.effectState.kind !== 'prepared'
    || attempt.turnBarrier.kind !== 'reserved-pre-effect'
    || attempt.recordVersion !== input.expectedAttemptRecordVersion) {
    return conflict('provider-turn attempt is not executable from prepared state', {
      terminalInputAttemptId: attempt.id,
      effectState: attempt.effectState.kind,
      turnBarrier: attempt.turnBarrier.kind,
    });
  }
  const startedAt = clockIso(core);
  const executing = await core.store.update<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', 'terminalInputAttempt', attempt.id,
    { effectState: { kind: 'executing', executionStartedAt: startedAt } },
    attempt.recordVersion,
    mintClientOpId(),
  );
  if (!executing.ok) return executing;
  attempt = executing.value;
  const live = core.live.lookup(attempt.terminalSessionId);
  if (live === undefined) {
    const uncertain = await core.store.update<ProviderTurnTerminalInputAttempt>(
      'sys_terminal', 'terminalInputAttempt', attempt.id,
      {
        effectState: {
          kind: 'submitted-unconfirmed',
          submittedAt: clockIso(core),
          reason: 'live process disappeared after execution began',
        },
        turnBarrier: { kind: 'active', activatedAt: clockIso(core) },
      },
      attempt.recordVersion,
      mintClientOpId(),
    );
    if (uncertain.ok) publishProviderTurnBarrier(core, uncertain.value);
    return uncertain;
  }
  let confirmed = true;
  try {
    const steps = await core.providerTurnDelivery(attempt.providerSessionId, input.utf8Text);
    for (const step of steps) {
      live.pty.write(step.utf8Text);
      if (step.pauseMsAfter > 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, step.pauseMsAfter); });
      }
    }
  } catch {
    confirmed = false;
  }
  live.nextInputSequence += 1;
  live.activeTurn = {
    providerTurnId: attempt.providerTurnId,
    activityGeneration: attempt.activityGeneration,
    agentRunId: attempt.agentRunId,
  };
  const submittedAt = clockIso(core);
  const submitted = await core.store.update<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', 'terminalInputAttempt', attempt.id,
    {
      effectState: confirmed
        ? { kind: 'submitted-confirmed', submittedAt }
        : { kind: 'submitted-unconfirmed', submittedAt, reason: 'provider effect outcome uncertain' },
      turnBarrier: { kind: 'active', activatedAt: submittedAt },
    },
    attempt.recordVersion,
    mintClientOpId(),
  );
  if (submitted.ok) publishProviderTurnBarrier(core, submitted.value);
  return submitted;
}

export async function cancelPreparedProviderTurnInput(
  core: TerminalCore,
  input: CancelPreparedProviderTurnInput,
): Promise<B3Result<ProviderTurnTerminalInputAttempt>> {
  const found = await exactAttempt(core, input.terminalInputAttemptId);
  if (!found.ok) return found;
  if (found.value === null) return conflict('unknown provider-turn input attempt', {
    terminalInputAttemptId: input.terminalInputAttemptId,
  });
  const attempt = found.value;
  if (attempt.effectState.kind === 'rejected'
    && attempt.turnBarrier.kind === 'released-rejected') return b3ok(attempt);
  if (attempt.effectState.kind !== 'prepared'
    || attempt.turnBarrier.kind !== 'reserved-pre-effect'
    || attempt.recordVersion !== input.expectedAttemptRecordVersion) {
    return conflict('only a prepared pre-effect reservation may be cancelled', {
      terminalInputAttemptId: attempt.id,
    });
  }
  const observedAt = clockIso(core);
  const cancelled = await core.store.update<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', 'terminalInputAttempt', attempt.id,
    {
      effectState: {
        kind: 'rejected', rejectedAt: observedAt, effectEscaped: false, reason: input.reason,
      },
      turnBarrier: { kind: 'released-rejected', releasedAt: observedAt },
    },
    attempt.recordVersion,
    mintClientOpId(),
  );
  if (cancelled.ok) publishProviderTurnBarrier(core, cancelled.value);
  return cancelled;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Exact tuple and interrupt ordering is explicit.
export async function settleProviderTurnCompletion(
  core: TerminalCore,
  input: SettleTerminalProviderTurnCompletionInput,
): Promise<B3Result<SettleTerminalProviderTurnCompletionOutcome>> {
  const found = await exactAttempt(core, input.terminalInputAttemptId);
  if (!found.ok) return found;
  if (found.value === null) return b3ok({ kind: 'target-turn-not-active', inputLeaseChanged: false });
  const attempt = found.value;
  if (attempt.agentRunId !== input.agentRunId
    || attempt.providerTurnId !== input.providerTurnId
    || attempt.activityGeneration !== input.activityGeneration) {
    return b3ok({ kind: 'target-turn-not-active', inputLeaseChanged: false });
  }
  if (attempt.turnBarrier.kind === 'completion-committed') {
    if (attempt.turnBarrier.transcriptTurnCompletionId !== input.transcriptTurnCompletionId
      || attempt.turnBarrier.providerUsageEvidenceId !== input.providerUsageEvidenceId) {
      return b3ok({ kind: 'target-turn-not-active', inputLeaseChanged: false });
    }
    return b3ok({
      kind: 'already-settled-same-completion',
      attemptRecordVersion: attempt.recordVersion,
      interruptDisposition: attempt.turnBarrier.interruptDisposition,
    });
  }
  if (attempt.turnBarrier.kind !== 'active'
    && attempt.turnBarrier.kind !== 'interrupt-committed') {
    return b3ok({ kind: 'target-turn-not-active', inputLeaseChanged: false });
  }
  const interruptDisposition = attempt.turnBarrier.kind === 'interrupt-committed'
    ? 'barrier-won-before-completion' as const
    : 'no-barrier' as const;
  const observedAt = clockIso(core);
  const written = await core.store.update<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', 'terminalInputAttempt', attempt.id,
    {
      turnBarrier: {
        kind: 'completion-committed',
        committedAt: observedAt,
        transcriptTurnCompletionId: input.transcriptTurnCompletionId,
        providerUsageEvidenceId: input.providerUsageEvidenceId,
        interruptDisposition,
        ...(attempt.turnBarrier.kind === 'interrupt-committed'
          ? { interruptBarrier: interruptBarrier(attempt.turnBarrier) }
          : {}),
      },
    },
    attempt.recordVersion,
    mintClientOpId(),
  );
  if (!written.ok) return written;
  publishProviderTurnBarrier(core, written.value);
  const live = core.live.lookup(attempt.terminalSessionId);
  if (live?.activeTurn?.providerTurnId === attempt.providerTurnId) live.activeTurn = null;
  return b3ok({
    kind: 'completion-barrier-committed',
    attemptRecordVersion: written.value.recordVersion,
    interruptDisposition,
  });
}

export async function closeProviderTurnBarrierUnproven(
  core: TerminalCore,
  input: CloseTerminalProviderTurnUnprovenInput,
): Promise<B3Result<ProviderTurnTerminalInputAttempt>> {
  const found = await exactAttempt(core, input.terminalInputAttemptId);
  if (!found.ok) return found;
  if (found.value === null) return conflict('unknown provider-turn input attempt', {
    terminalInputAttemptId: input.terminalInputAttemptId,
  });
  const attempt = found.value;
  if (attempt.agentRunId !== input.agentRunId
    || attempt.providerTurnId !== input.providerTurnId
    || attempt.activityGeneration !== input.activityGeneration) {
    return conflict('unproven close tuple does not match attempt', {
      terminalInputAttemptId: input.terminalInputAttemptId,
      agentRunId: input.agentRunId,
      providerTurnId: input.providerTurnId,
      activityGeneration: input.activityGeneration,
    });
  }
  if (attempt.turnBarrier.kind === 'closed-unproven') return b3ok(attempt);
  if (attempt.turnBarrier.kind !== 'active'
    && attempt.turnBarrier.kind !== 'interrupt-committed') {
    return conflict('attempt barrier is not eligible for unproven close', {
      turnBarrier: attempt.turnBarrier.kind,
    });
  }
  const observedAt = clockIso(core);
  const closed = await core.store.update<ProviderTurnTerminalInputAttempt>(
    'sys_terminal', 'terminalInputAttempt', attempt.id,
    {
      turnBarrier: {
        kind: 'closed-unproven',
        closedAt: observedAt,
        terminalFinalEvidenceRefs: input.terminalFinalEvidenceRefs,
        interruptDisposition: attempt.turnBarrier.kind === 'interrupt-committed'
          ? 'barrier-won-before-unproven-close'
          : 'no-barrier',
        ...(attempt.turnBarrier.kind === 'interrupt-committed'
          ? { interruptBarrier: interruptBarrier(attempt.turnBarrier) }
          : {}),
      },
    },
    attempt.recordVersion,
    mintClientOpId(),
  );
  if (closed.ok) publishProviderTurnBarrier(core, closed.value);
  return closed;
}

export async function getProviderTurnInputAttempt(
  core: TerminalCore,
  input: GetProviderTurnInputAttemptInput,
): Promise<B3Result<ProviderTurnTerminalInputAttempt>> {
  const attempts = await listProviderTurnAttempts(core, { terminalSessionId: input.terminalSessionId });
  if (!attempts.ok) return attempts;
  const found = attempts.value.find((attempt) =>
    attempt.providerTurnId === input.providerTurnId
    && attempt.submissionEffectKey === input.submissionEffectKey);
  return found === undefined
    ? conflict('no provider-turn attempt matches the exact query tuple', {
      terminalSessionId: input.terminalSessionId,
      providerTurnId: input.providerTurnId,
      submissionEffectKey: input.submissionEffectKey,
    })
    : b3ok(found);
}

export async function listIncompleteProviderTurnInputAttempts(
  core: TerminalCore,
  filter: IncompleteProviderTurnInputAttemptFilter,
): Promise<B3Result<B3Page<ProviderTurnTerminalInputAttempt>>> {
  const attempts = await listProviderTurnAttempts(core, {
    ...(filter.terminalSessionId === undefined
      ? {} : { terminalSessionId: filter.terminalSessionId }),
    ...(filter.agentRunId === undefined ? {} : { agentRunId: filter.agentRunId }),
  });
  if (!attempts.ok) return attempts;
  const states = filter.states;
  const items = attempts.value
    .filter((attempt) => !attemptTerminal(attempt))
    .filter((attempt) => states === undefined || states.includes(attempt.effectState.kind as never));
  return keysetPage(items, filter);
}

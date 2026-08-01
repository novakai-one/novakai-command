// Continuations (DEC-B3V4-19, §13.6, red gate 8).
//
// Chris's actual pain, from question 23: `--resume` is often NOT what you want,
// because it reloads the whole context and every turn costs more. So the four
// modes are first-class and NONE of them is automatic — the caller names one,
// every time, and gets a new Run either way.
//
// A continuation is not a child. It writes `RunContinuation`, never
// `AgentRelationship`: restarting yourself must never look like spawning a
// subordinate.
import {
  b3fail, b3ok, mintAgentRunId, mintClientOpId, mintRunContinuationId, nowIsoUtc,
  type ActivityGeneration, type B3Result, type CommandContext,
  type ProviderSessionId, type ResolvedLaunchPlanId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { ContinueAgentInput } from '../contract/runs-api.js';
import type { LaunchPlanFacts } from '../contract/ports.js';
import {
  FINAL_LIFECYCLES,
  type AgentRun, type ContinuationMode, type RunContinuation, type RunOperation,
} from '../contract/runs.js';
import { patchRun, requireRun, type RunsCore } from './runs-context.js';
import { recoveryRequired, runFinal, type Persisted } from './runs-store.js';
import { advance, compensate, openOperation } from './journal.js';
import { runSkillsGate } from './gate.js';
import { startReplacement, type ContinuationWork } from './continue-launch.js';
import { closeRun } from './lifecycle.js';
import { insideClosingTree, treeClosing } from './stop-tree.js';

export interface ContinuationOutcome {
  readonly agentRun: AgentRun;
  readonly plan: LaunchPlanFacts;
  readonly operation: RunOperation;
}

export async function continueAgent(
  core: RunsCore, context: CommandContext, input: ContinueAgentInput,
): Promise<B3Result<ContinuationOutcome>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;

  const oldRun = await continuableRun(core, context, input);
  if (!oldRun.ok) return oldRun;

  const journal = await openContinuationJournal(core, context, input, oldRun.value, epoch.value);
  if (!journal.ok) return journal;

  const performed = await performContinuation(core, context, {
    input,
    oldRun: oldRun.value,
    operation: journal.value.operation,
    reserved: journal.value.reserved,
    epochId: epoch.value,
  });
  if (performed.ok) return performed;
  const unwound = await unwind(core, journal.value.operation, oldRun.value, epoch.value, performed.error.message);
  return unwound.ok ? performed : unwound;
}

/**
 * The Run this continuation may act on, and every reason it may not.
 *
 * All of it refuses BEFORE any effect: the caller's authority, a tree already
 * closing, a Run belonging to somebody else, a Run that is already over, and a
 * mode the pinned plan or the provider does not offer.
 */
async function continuableRun(
  core: RunsCore, context: CommandContext, input: ContinueAgentInput,
): Promise<B3Result<AgentRun>> {
  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: input.agentId, operation: 'continue',
  });
  if (!authorised.ok) return authorised;

  const fenced = await insideClosingTree(core, context, input.agentId);
  if (!fenced.ok) return fenced;
  if (fenced.value !== null) {
    return b3fail(treeClosing(fenced.value.rootAgentId, fenced.value.id));
  }

  const oldRun = await requireRun(core, input.expectedOldRunId);
  if (!oldRun.ok) return oldRun;
  if (oldRun.value.agentId !== input.agentId) {
    return b3fail(recoveryRequired(input.expectedOldRunId, 'old-run-fenced',
      'that agentRun belongs to a different Agent'));
  }
  if (FINAL_LIFECYCLES.has(oldRun.value.lifecycle)) {
    return b3fail(runFinal(oldRun.value.id, oldRun.value.lifecycle));
  }

  const allowed = await core.agents.continuationAllowed(context.principal, {
    launchPlanId: oldRun.value.launchPlanId, mode: input.mode,
  });
  return allowed.ok ? b3ok(oldRun.value) : b3fail(allowed.error);
}

/** Everything a failed continuation owes: the journal, then the fenced Run. */
async function unwind(
  core: RunsCore,
  operation: RunOperation,
  oldRun: AgentRun,
  epochId: RuntimeEpochId,
  reason: string,
): Promise<B3Result<null>> {
  await compensate(core, operation, epochId, reason);
  return releaseFencedRun(core, oldRun.id, reason);
}

/**
 * The Run a failed continuation was replacing.
 *
 * §13.6 fences it FIRST, so it stops accepting new work while the replacement is
 * provisioned. When the replacement dies, that fence is a promise about a
 * successor that does not exist: the Run is neither live nor final, its provider
 * is still running, and until now it appeared in no recovery list at all — it
 * read as in-flight for ever (NVK-KIMI-030 N-2).
 *
 * It is not stopped here. Stopping it would kill a working provider on the
 * strength of a failure that happened somewhere else, and §20's rule for an
 * unconfirmed old endpoint is "human/script decides". So it is recorded as
 * needing recovery, with the reason, and stays continuable and stoppable.
 */
async function releaseFencedRun(
  core: RunsCore, oldRunId: AgentRun['id'], reason: string,
): Promise<B3Result<null>> {
  const current = await requireRun(core, oldRunId);
  if (!current.ok) return current;
  if (current.value.lifecycle !== 'continuation-pending') return b3ok(null);
  const patched = await patchRun(core, current.value, {
    lifecycle: 'recovery-required',
    activity: 'unknown',
    uncertainty: [{
      code: 'cleanup-incomplete',
      summary: `the continuation that fenced this Run failed (${reason}); its provider `
        + 'was left running and no replacement took over',
      evidenceRefs: [current.value.terminalSessionId ?? 'no terminal was recorded'],
    }],
  });
  return patched.ok ? b3ok(null) : b3fail(patched.error);
}

/** The journal, plus the reservation minted before any effect (§5.4, §20). */
async function openContinuationJournal(
  core: RunsCore,
  context: CommandContext,
  input: ContinueAgentInput,
  oldRun: AgentRun,
  epochId: RuntimeEpochId,
): Promise<B3Result<{ operation: RunOperation; reserved: ProviderSessionId }>> {
  const opened = await openOperation(core, context, {
    kindOfOperation: 'continue',
    runtimeEpochId: epochId,
    agentId: input.agentId,
    oldRunId: oldRun.id,
    reserveProviderSession: true,
  });
  if (!opened.ok) return opened;
  const reserved = opened.value.operation.reservedProviderSessionId;
  if (reserved === undefined) {
    return b3fail(recoveryRequired(opened.value.operation.id, opened.value.operation.currentStage,
      'the continuation was journalled without its provider-session reservation'));
  }
  return b3ok({ operation: opened.value.operation, reserved });
}

/**
 * §13.6's order. The old Run is fenced FIRST, so nothing new can start on it
 * while the new one is being provisioned, and it goes final LAST, so there is
 * never a moment with no Run at all.
 */
async function performContinuation(
  core: RunsCore, context: CommandContext, work: ContinuationWork,
): Promise<B3Result<ContinuationOutcome>> {
  const drained = await fenceAndDrainOldRun(core, work);
  if (!drained.ok) return drained;
  let operation = drained.value.operation;
  const fencedOld = drained.value.oldRun;

  const plan = await resolvePlanFor(core, context, work);
  if (!plan.ok) return plan;

  const started = await startReplacement(core, context, { ...work, operation, plan: plan.value });
  if (!started.ok) return started;
  operation = started.value.operation;

  // A replacement Run is a NEW provider context, so it confirms its skills the
  // same way a fresh spawn does. Restarting is not a way around the gate: §6.3
  // gives every managed launch its own, and a parent's earlier confirmation is
  // never accepted on a successor's behalf.
  const gated = await runSkillsGate(core, context, {
    agentRun: started.value.agentRun,
    plan: plan.value,
    operation,
    brief: continuationBrief(work.input.mode),
    supervised: plan.value.skillsConfirmationGate.mode === 'required-two-turn',
  });
  if (!gated.ok) return gated;
  operation = gated.value.operation;

  const linked = await linkContinuation(core, context, {
    ...work, newRun: started.value.agentRun, resumeHandleUsed: started.value.resumeHandleUsed,
  });
  if (!linked.ok) return linked;

  const transferred = await advance(core, operation, {
    stage: 'endpoint-transferred', owner: 'messaging', outcome: 'not-needed', notNeededBecause: 'B3c',
  });
  if (!transferred.ok) return transferred;
  operation = transferred.value;

  const ready = await patchRun(core, started.value.agentRun, {
    lifecycle: 'ready', activity: 'idle', startedAt: nowIsoUtc(),
  });
  if (!ready.ok) return ready;

  // Only now is the old Run final: replaced, not stopped by a human.
  const retired = await closeRun(
    core, context, fencedOld, 'replaced-by-continuation', work.epochId,
  );
  if (!retired.ok) return retired;

  const completedStage = await advance(core, operation, {
    stage: 'run-ready', owner: 'agent-runtime', ownerObjectId: started.value.agentRun.id,
  }, { state: 'completed', newRunId: started.value.agentRun.id });
  if (!completedStage.ok) return completedStage;
  return b3ok({ agentRun: ready.value, plan: plan.value, operation: completedStage.value });
}

/**
 * §13.6's first half: the old Run stops accepting new work, and every downstream
 * finalisation is recorded — including the ones whose owning capability arrives
 * in a later slice, which are `not-needed` rather than silently absent.
 */
async function fenceAndDrainOldRun(
  core: RunsCore, work: ContinuationWork,
): Promise<B3Result<{ oldRun: AgentRun; operation: RunOperation }>> {
  const fencedOld = await patchRun(core, work.oldRun, { lifecycle: 'continuation-pending' });
  if (!fencedOld.ok) return fencedOld;
  let operation = await advance(core, work.operation, {
    stage: 'old-run-fenced', owner: 'agent-runtime', ownerObjectId: work.oldRun.id,
  }, { state: 'continuation-pending' });
  if (!operation.ok) return operation;

  const deferred = [
    { stage: 'old-endpoint-drained', owner: 'messaging', slice: 'B3c' },
    { stage: 'old-transcript-finalised', owner: 'transcript', slice: 'B3c' },
    { stage: 'old-usage-finalised', owner: 'messaging', slice: 'B3d' },
  ] as const;
  for (const step of deferred) {
    operation = await advance(core, operation.value, {
      stage: step.stage, owner: step.owner, outcome: 'not-needed', notNeededBecause: step.slice,
    });
    if (!operation.ok) return operation;
  }
  return b3ok({ oldRun: fencedOld.value, operation: operation.value });
}

/**
 * `inherit-plan` keeps the exact plan; `refresh-role` rebuilds it from the
 * role as it is TODAY; a signed replacement uses the plan a control proposed.
 * The caller says which — none of the three happens by default (DEC-B3V4-31).
 */
async function resolvePlanFor(
  core: RunsCore, context: CommandContext, work: ContinuationWork,
): Promise<B3Result<LaunchPlanFacts>> {
  const previous = await core.agents.getLaunchPlan(context.principal, work.oldRun.launchPlanId);
  if (!previous.ok) return previous;

  if (work.input.configurationMode === 'signed-control-replacement') {
    if (work.input.replacementPlanId === undefined) {
      return b3fail(recoveryRequired(work.operation.id, 'launch-plan-recorded',
        'a signed control replacement needs its plan id'));
    }
    const replacement = await core.agents.getControlReplacementPlan(
      context.principal, work.input.replacementPlanId,
    );
    if (!replacement.ok) return replacement;
    if (replacement.value.expectedOldRunId !== work.oldRun.id) {
      return b3fail(recoveryRequired(work.operation.id, 'launch-plan-recorded',
        'that replacement plan was signed for a different Run'));
    }
    return core.agents.getLaunchPlan(
      context.principal, replacement.value.proposedLaunchPlanId as ResolvedLaunchPlanId,
    );
  }

  return core.agents.resolveLaunchPlan(context, {
    agentId: work.input.agentId,
    configurationMode: work.input.configurationMode,
    ...(work.input.configurationMode === 'inherit-plan'
      ? { inheritedPlanId: work.oldRun.launchPlanId } : {}),
    workingDirectory: previous.value.workingDirectory,
    // A continuation inherits whether its predecessor was supervised: a gate
    // cannot be dropped by restarting (§6.3).
    supervised: previous.value.skillsConfirmationGate.mode === 'required-two-turn',
  });
}

/** The edge that says "this Run replaced that one, and how". Never a family edge. */
async function linkContinuation(
  core: RunsCore,
  context: CommandContext,
  work: ContinuationWork & { readonly newRun: AgentRun; readonly resumeHandleUsed: boolean },
): Promise<B3Result<RunContinuation>> {
  const record: Persisted<RunContinuation> = {
    kind: 'runContinuation',
    id: mintRunContinuationId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    agentId: work.input.agentId,
    fromRunId: work.oldRun.id,
    toRunId: work.newRun.id,
    mode: work.input.mode,
    configurationMode: work.input.configurationMode,
    providerResumeHandleUsed: work.resumeHandleUsed,
    ...(work.input.handoverArtifactId === undefined
      ? {} : { handoverArtifactId: work.input.handoverArtifactId }),
  };
  return core.store.create<RunContinuation>(
    context.principal.id, record as never, mintClientOpId(),
  );
}

/** What the replacement is told it is doing, so turn 1 has honest context. */
function continuationBrief(mode: ContinuationMode): string {
  const shape: Readonly<Record<ContinuationMode, string>> = {
    resume: 'You are resuming your own earlier session. Continue where it left off.',
    fresh: 'You are a fresh context replacing your own earlier session. Its history '
      + 'is deliberately not loaded.',
    compact: 'You are continuing your own earlier session from a compacted context.',
    handover: 'You are taking over from an earlier session through a written handover.',
  };
  return shape[mode] ?? shape.fresh;
}

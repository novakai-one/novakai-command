// Interrupt, stop one, stop a tree.
//
// Three operations that are constantly mistaken for each other, kept apart on
// purpose:
//   - INTERRUPT cancels the current turn. The Run stays live. Children carry on.
//   - STOP ends one Run and applies the recorded orphan policy to its children.
//   - STOP-TREE is a separate scope, a separate confirmation, and a fence.
import {
  b3err, b3fail, b3ok, mintProviderTurnId, nowIsoUtc,
  type ActivityGeneration, type AgentId, type AgentRunId, type B3Result,
  type CommandContext, type ProviderTurnId, type RecordVersion, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type {
  InterruptAgentTurnInput, InterruptAgentTurnOutcome, StopAgentInput,
} from '../contract/runs-api.js';
import { FINAL_LIFECYCLES, type AgentRun } from '../contract/runs.js';
import {
  closeEndpointOf, expireAuthorityOf, liveRunOf, patchRun, requireRun, type RunsCore,
} from './runs-context.js';
import { applyOrphanPolicy } from './orphan-policy.js';
import { runFinal } from './runs-store.js';
import { advance } from './journal.js';

// ── Interrupt ───────────────────────────────────────────────────────

/**
 * The order is not advice; a different order loses the race.
 *
 * Snapshot the active tuple, ask Terminal to compare-and-set a barrier against
 * that EXACT tuple, and only then treat the turn as interrupted. If the tuple is
 * no longer active nothing changes at all — the lease, the draft and the queued
 * input are untouched, because the caller was interrupting something that had
 * already finished.
 */
/** Everything that must be true before an interrupt may even be attempted. */
async function interruptableRun(
  core: RunsCore, context: CommandContext, input: InterruptAgentTurnInput,
): Promise<B3Result<AgentRun>> {
  const agentRun = await requireRun(core, input.agentRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value.recordVersion !== input.expectedRecordVersion) {
    return b3fail(b3err('VersionConflict', 'the run changed since it was read',
      {
        objectId: agentRun.value.id,
        expected: input.expectedRecordVersion,
        actual: agentRun.value.recordVersion,
      }, true));
  }
  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: agentRun.value.agentId, operation: 'interrupt',
  });
  if (!authorised.ok) return authorised;
  if (FINAL_LIFECYCLES.has(agentRun.value.lifecycle)) {
    return b3fail(runFinal(agentRun.value.id, agentRun.value.lifecycle));
  }
  return agentRun;
}

export async function interruptAgentTurn(
  core: RunsCore, context: CommandContext, input: InterruptAgentTurnInput,
): Promise<B3Result<InterruptAgentTurnOutcome>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  const agentRun = await interruptableRun(core, context, input);
  if (!agentRun.ok) return agentRun;

  const active = agentRun.value.activeProviderTurn;
  if (active === undefined || agentRun.value.terminalSessionId === undefined) {
    return b3ok({
      kind: 'not-working',
      agentRunId: agentRun.value.id,
      activityGeneration: agentRun.value.activityGeneration,
      inputLeaseChanged: false,
    });
  }

  const barrier = await core.terminal.interruptTurn({
    terminalSessionId: agentRun.value.terminalSessionId,
    agentRunId: agentRun.value.id,
    providerTurnId: active.providerTurnId,
    activityGeneration: active.activityGeneration,
    expectedRuntimeEpochId: epoch.value,
  });
  if (!barrier.ok) return barrier;

  if (barrier.value.kind === 'target-turn-not-active') {
    // Nothing was changed, and nothing is claimed: the turn was already over.
    return b3ok({
      kind: 'not-working',
      agentRunId: agentRun.value.id,
      activityGeneration: agentRun.value.activityGeneration,
      inputLeaseChanged: false,
    });
  }

  const interrupting = await patchRun(core, agentRun.value, {
    activity: 'interrupting',
    activityGeneration: (agentRun.value.activityGeneration + 1) as ActivityGeneration,
    activeProviderTurn: { ...active, state: 'interrupting' },
  });
  if (!interrupting.ok) return interrupting;
  const announced = await core.publish('agent.run.interrupt.barrier-committed', {
    agentRunId: agentRun.value.id, providerTurnId: active.providerTurnId,
  });
  if (!announced.ok) return b3fail(announced.error);

  const plan = await core.agents.getLaunchPlan(context.principal, agentRun.value.launchPlanId);
  if (plan.ok && agentRun.value.providerSessionId !== undefined) {
    await core.providers.requestInterrupt({
      provider: plan.value.provider,
      providerSessionId: agentRun.value.providerSessionId,
      providerTurnId: active.providerTurnId,
      activityGeneration: active.activityGeneration,
    });
  }

  if (barrier.value.kind === 'raced-with-completion') {
    // The barrier WON the ordering race, so the visible revocation stands even
    // though the turn finished underneath it. Reporting anything else would
    // pretend the lease stayed valid.
    return b3ok({
      kind: 'raced-with-completion',
      agentRunId: agentRun.value.id,
      providerTurnId: active.providerTurnId,
      inputLeaseRevoked: true,
    });
  }
  return b3ok({
    kind: 'interrupted',
    agentRunId: agentRun.value.id,
    providerTurnId: active.providerTurnId,
    activityGeneration: interrupting.value.activityGeneration,
    inputLeaseRevoked: true,
  });
}

// ── Activity ────────────────────────────────────────────────────────

/**
 * A turn started. Run identity does not change; the ACTIVITY generation does,
 * and the tuple `{ProviderTurnId, ActivityGeneration}` is what an interrupt
 * barrier is later compared against.
 */
export async function beginProviderTurn(
  core: RunsCore,
  context: CommandContext,
  input: { readonly agentRunId: AgentRunId; readonly expectedRecordVersion: RecordVersion },
): Promise<B3Result<AgentRun>> {
  const agentRun = await requireRun(core, input.agentRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value.recordVersion !== input.expectedRecordVersion) {
    return b3fail(b3err('VersionConflict', 'the run changed since it was read',
      {
        objectId: agentRun.value.id,
        expected: input.expectedRecordVersion,
        actual: agentRun.value.recordVersion,
      }, true));
  }
  if (FINAL_LIFECYCLES.has(agentRun.value.lifecycle)) {
    return b3fail(runFinal(agentRun.value.id, agentRun.value.lifecycle));
  }
  const generation = (agentRun.value.activityGeneration + 1) as ActivityGeneration;
  const providerTurnId = mintProviderTurnId();
  const working = await patchRun(core, agentRun.value, {
    activity: 'working',
    activityGeneration: generation,
    activeProviderTurn: {
      providerTurnId, activityGeneration: generation, startedAt: nowIsoUtc(), state: 'working',
    },
  });
  if (!working.ok) return working;
  if (agentRun.value.terminalSessionId !== undefined) {
    // Terminal cannot judge an interrupt barrier without knowing the tuple.
    await core.terminal.beginProviderTurn({
      terminalSessionId: agentRun.value.terminalSessionId,
      agentRunId: agentRun.value.id,
      providerTurnId,
      activityGeneration: generation,
    });
  }
  void context;
  return working;
}

export async function endProviderTurn(
  core: RunsCore,
  context: CommandContext,
  input: { readonly agentRunId: AgentRunId; readonly providerTurnId: ProviderTurnId },
): Promise<B3Result<AgentRun>> {
  const agentRun = await requireRun(core, input.agentRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value.activeProviderTurn?.providerTurnId !== input.providerTurnId) {
    // Ending a turn that is not the active one is a no-op, not an error: the
    // turn already ended, which is what the caller wanted.
    return agentRun;
  }
  const idle = await patchRun(core, agentRun.value, {
    activity: 'idle',
    activityGeneration: (agentRun.value.activityGeneration + 1) as ActivityGeneration,
    activeProviderTurn: undefined,
  });
  if (!idle.ok) return idle;
  if (agentRun.value.terminalSessionId !== undefined) {
    await core.terminal.endProviderTurn({
      terminalSessionId: agentRun.value.terminalSessionId,
      providerTurnId: input.providerTurnId,
    });
  }
  void context;
  return idle;
}

// ── Stop one ──────────────────────────────────────────────────

export async function stopAgent(
  core: RunsCore, context: CommandContext, input: StopAgentInput,
): Promise<B3Result<AgentRun>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  const agentRun = await requireRun(core, input.expectedLiveRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value.agentId !== input.agentId) {
    return b3fail(b3err('UnknownAgentRun',
      'that agentRun does not belong to that agent',
      { agentRunId: input.expectedLiveRunId }, false));
  }
  // `expectedLiveRunId` is a compare-and-set, and it has to LOSE when it names
  // a Run that is no longer the live one. `closeRun` is idempotent on a final
  // Run, so a stale id used to return a cheerful success while the Agent's
  // actual Run kept running and kept billing.
  const live = await liveRunOf(core, input.agentId);
  if (!live.ok) return live;
  if (live.value !== null && live.value.id !== agentRun.value.id) {
    return b3fail(b3err('VersionConflict',
      'that Run is not the one this Agent is running now',
      {
        objectId: input.agentId,
        expected: input.expectedLiveRunId,
        actual: live.value.id,
        liveAgentRunId: live.value.id,
      }, false));
  }

  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: input.agentId, operation: 'stop-one',
  });
  if (!authorised.ok) return authorised;
  const closing = await closeRun(core, context, agentRun.value, 'explicit-stop', epoch.value);
  if (!closing.ok) return closing;
  const orphans = await applyOrphanPolicy(core, context, input.agentId);
  if (!orphans.ok) return orphans;
  return closing;
}

/** Stop the PTY, end the Run, and retire every grant its authority came from. */
export async function closeRun(
  core: RunsCore,
  context: CommandContext,
  agentRun: AgentRun,
  finalReason: AgentRun['finalReason'],
  epochId: RuntimeEpochId,
): Promise<B3Result<AgentRun>> {
  if (FINAL_LIFECYCLES.has(agentRun.lifecycle)) return b3ok(agentRun); // idempotent
  const stopping = await patchRun(core, agentRun, { lifecycle: 'stopping' });
  if (!stopping.ok) return stopping;

  if (agentRun.terminalSessionId !== undefined) {
    const ended = await core.terminal.terminate({
      terminalSessionId: agentRun.terminalSessionId,
      agentRunId: agentRun.id,
      expectedRuntimeEpochId: epochId,
      reason: finalReason === 'explicit-tree-stop' ? 'stop-tree' : 'stop-one',
    });
    if (!ended.ok) {
      // The PTY's fate is UNCERTAIN, so the Run says so rather than claiming a
      // clean stop: never silently kill, never silently claim.
      return patchRun(core, stopping.value, {
        lifecycle: 'recovery-required',
        uncertainty: [{
          code: 'cleanup-incomplete',
          summary: `the managed terminal could not be stopped: ${ended.error.message}`,
          evidenceRefs: [agentRun.terminalSessionId],
        }],
      });
    }
  }

  const stopped = await patchRun(core, stopping.value, {
    lifecycle: 'stopped', activity: 'idle', finalAt: nowIsoUtc(), finalReason,
  });
  if (!stopped.ok) return stopped;
  // `expiresWhenIssuerRunFinal`, made real.
  await expireAuthorityOf(core, agentRun);
  await closeEndpointOf(core, agentRun);
  void context;
  return stopped;
}

export { advance };

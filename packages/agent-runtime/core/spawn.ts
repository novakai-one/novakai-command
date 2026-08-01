// The spawn saga (§13.5, DEC-B3V4-26).
//
// One operation serves a human at a keyboard, an Agent inside its own PTY, and
// a script in a cron job. They differ in exactly one place — who the transport
// authenticated — and everything downstream is identical, which is the cheapest
// way to hold red gate 23.
//
// Every stage advances only after its owner confirmed something durable, and
// every effect underneath is keyed by this command's `clientOpId`, so a retry
// adopts what already happened instead of doing it twice.
import {
  b3fail, b3ok, mintAgentRunId,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type ProviderSessionId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { SpawnAgentInput } from '../contract/runs-api.js';
import type { LaunchPlanFacts, SpawnAuthorityFacts } from '../contract/ports.js';
import type { AgentRun, LaunchSurface, RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import { recoveryRequired } from './runs-store.js';
import { advance, compensate, openOperation } from './journal.js';
import { runSkillsGate } from './gate.js';
import {
  bindProviderSession, finishRun, recordDeferredStages, reserveRun, startTerminal,
} from './spawn-stages.js';

export interface SpawnOutcome {
  readonly agentRun: AgentRun;
  readonly plan: LaunchPlanFacts;
  readonly operation: RunOperation;
}

export async function spawnAgent(
  core: RunsCore, context: CommandContext, input: SpawnAgentInput,
): Promise<B3Result<SpawnOutcome>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;

  // Authority FIRST. A caller who may not spawn learns so before a journal
  // record exists, let alone an Agent (§13.5's ordering is not decoration).
  const authority = await core.agents.authoriseSpawn(context.principal, {
    roleProfileId: input.roleProfileId,
    ...(context.principal.agentRunId === undefined
      ? {} : { callerAgentRunId: context.principal.agentRunId }),
    ...(await callerAgentIdOf(core, context)),
  });
  if (!authority.ok) return authority;

  const opened = await openOperation(core, context, {
    kindOfOperation: 'spawn',
    runtimeEpochId: epoch.value,
    reserveProviderSession: true,
  });
  if (!opened.ok) return opened;
  let operation = opened.value.operation;
  if (operation.state === 'recovery-required') {
    return b3fail(recoveryRequired(operation.id, operation.currentStage,
      'an earlier attempt left an uncertain effect'));
  }
  const reserved = operation.reservedProviderSessionId;
  if (reserved === undefined) {
    return b3fail(recoveryRequired(operation.id, operation.currentStage,
      'the operation was journalled without its provider-session reservation'));
  }

  const built = await buildRun(core, context, {
    input, authority: authority.value, operation, epochId: epoch.value, reserved,
  });
  if (!built.ok) {
    // Undo what we can, say what we cannot, and never leave an unowned PTY.
    await compensate(core, operation, epoch.value, built.error.message);
    return built;
  }
  operation = built.value.operation;
  return b3ok(built.value);
}

interface BuildInput {
  readonly input: SpawnAgentInput;
  readonly authority: SpawnAuthorityFacts;
  readonly operation: RunOperation;
  readonly epochId: RuntimeEpochId;
  readonly reserved: ProviderSessionId;
}

interface Governed {
  readonly agentId: AgentId;
  readonly plan: LaunchPlanFacts;
  readonly supervised: boolean;
  readonly operation: RunOperation;
}

/**
 * Everything Agents decides, before the Runtime touches a process: who the
 * Agent is, which family edge it sits on, and exactly what it may launch with.
 */
async function governedIdentity(
  core: RunsCore, context: CommandContext, build: BuildInput,
): Promise<B3Result<Governed>> {
  const leased = await advance(core, build.operation, {
    stage: 'agent-lease-acquired', owner: 'agent-runtime',
  });
  if (!leased.ok) return leased;

  // The Agent and its family edge are created by ONE Agents command, keyed by
  // this command's clientOpId — so a retry finds the same Agent rather than a
  // twin. The ladder records the two stages the spec names, in its order.
  const created = await core.agents.createAgentFromRole(context, {
    roleProfileId: build.input.roleProfileId,
    displayName: build.input.displayName,
    rootHumanPrincipalId: build.authority.rootHumanPrincipalId,
    ...(build.authority.parentAgentId === undefined
      ? {} : { parentAgentId: build.authority.parentAgentId, creatingRunId: mintAgentRunId() }),
  });
  if (!created.ok) return created;
  const agentId = created.value.agent.id;

  const supervised = build.input.task?.kind === 'supervised';
  const plan = await core.agents.resolveLaunchPlan(context, {
    agentId,
    configurationMode: 'refresh-role',
    ...requestedOverrides(build.input),
    workingDirectory: build.input.workingDirectory,
    supervised,
  });
  if (!plan.ok) return plan;

  const planned = await advance(core, leased.value, {
    stage: 'launch-plan-recorded', owner: 'agents', ownerObjectId: plan.value.id,
  }, { agentId });
  if (!planned.ok) return planned;

  const related = await advance(core, planned.value, {
    stage: 'relationship-recorded',
    owner: 'agents',
    ...(build.authority.parentAgentId === undefined
      ? { outcome: 'not-needed' as const } : { ownerObjectId: build.authority.parentAgentId }),
  });
  if (!related.ok) return related;
  return b3ok({ agentId, plan: plan.value, supervised, operation: related.value });
}

/** Only the overrides the caller actually asked for reach the resolver. */
function requestedOverrides(input: SpawnAgentInput): {
  requestedProvider?: SpawnAgentInput['requestedProvider'];
  requestedModelId?: string;
  requestedEffort?: string;
} {
  return {
    ...(input.requestedProvider === undefined
      ? {} : { requestedProvider: input.requestedProvider }),
    ...(input.requestedModelId === undefined
      ? {} : { requestedModelId: input.requestedModelId }),
    ...(input.requestedEffort === undefined
      ? {} : { requestedEffort: input.requestedEffort }),
  };
}

async function buildRun(
  core: RunsCore, context: CommandContext, build: BuildInput,
): Promise<B3Result<SpawnOutcome>> {
  const governed = await governedIdentity(core, context, build);
  if (!governed.ok) return governed;

  const provisioned = await provisionRun(core, context, build, governed.value);
  if (!provisioned.ok) return provisioned;

  const ready = await finishRun(core, context, {
    agentRun: provisioned.value.agentRun,
    operation: provisioned.value.operation,
    agentId: governed.value.agentId,
    authority: build.authority,
  });
  if (!ready.ok) return ready;
  return b3ok({
    agentRun: ready.value.agentRun,
    plan: governed.value.plan,
    operation: ready.value.operation,
  });
}

/** The Run record, its PTY, its provider session, and its skills gate. */
async function provisionRun(
  core: RunsCore, context: CommandContext, build: BuildInput, governed: Governed,
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation }>> {
  const reservedRun = await reserveRun(core, context, {
    agentId: governed.agentId, plan: governed.plan, authority: build.authority,
    reserved: build.reserved, operation: governed.operation,
  });
  if (!reservedRun.ok) return reservedRun;

  const deferred = await recordDeferredStages(
    core, reservedRun.value.operation, ['endpoint-reserved'],
  );
  if (!deferred.ok) return deferred;

  const live = await startTerminal(core, context, {
    agentRun: reservedRun.value.agentRun, plan: governed.plan,
    reserved: build.reserved, operation: deferred.value, epochId: build.epochId,
  });
  if (!live.ok) return live;

  const bound = await bindProviderSession(core, {
    agentRun: live.value.agentRun, plan: governed.plan,
    reserved: build.reserved, operation: live.value.operation,
  });
  if (!bound.ok) return bound;

  const afterTranscript = await recordDeferredStages(
    core, bound.value, ['transcript-bound', 'endpoint-active'],
  );
  if (!afterTranscript.ok) return afterTranscript;

  const gated = await runSkillsGate(core, context, {
    agentRun: live.value.agentRun,
    plan: governed.plan,
    operation: afterTranscript.value,
    brief: build.input.task?.brief ?? '',
    supervised: governed.supervised,
  });
  if (!gated.ok) return gated;

  const watched = await recordDeferredStages(core, gated.value.operation, ['watchers-installed']);
  if (!watched.ok) return watched;
  return b3ok({ agentRun: gated.value.agentRun, operation: watched.value });
}

/** The Agent behind an authenticated Run, so a child's parent is never claimed. */
async function callerAgentIdOf(
  core: RunsCore, context: CommandContext,
): Promise<{ callerAgentId?: AgentId }> {
  const runId = context.principal.agentRunId;
  if (runId === undefined) return {};
  const agentRun = await core.store.read<AgentRun>('agentRun', runId as AgentRunId);
  if (!agentRun.ok || agentRun.value === null) return {};
  return { callerAgentId: agentRun.value.agentId };
}

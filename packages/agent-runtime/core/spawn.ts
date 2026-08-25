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
  b3fail, b3ok,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type ProviderSessionId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { SpawnAgentInput } from '../contract/runs-api.js';
import type { LaunchPlanFacts, SpawnAuthorityFacts } from '../contract/ports.js';
import type { AgentRun, LaunchSurface, RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import { recoveryRequired } from './runs-store.js';
import { advance, compensate, openOperation, unresolvedUncertainty } from './journal.js';
import { insideClosingTree, treeClosing } from './stop-tree.js';
import { runSkillsGate } from './gate.js';
import {
  bindProviderSession, finishRun, installWatchers, reserveRun, startTerminal,
} from './spawn-stages.js';
import { activateEndpoint, bindTranscript, reserveEndpoint } from './spawn-b3c.js';
import { provisionHeadlessChild } from './headless-child.js';

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

  const open = await treeAcceptsAChild(core, context, authority.value.parentAgentId);
  if (!open.ok) return open;

  const headlessChild = authority.value.parentAgentId !== undefined
    && input.task?.brief !== undefined
    && core.headlessChildMessaging !== undefined;

  const opened = await openOperation(core, context, {
    kindOfOperation: 'spawn',
    runtimeEpochId: epoch.value,
    reserveProviderSession: !headlessChild,
  });
  if (!opened.ok) return opened;
  let operation = opened.value.operation;
  const blocked = resumeRefusal(operation);
  if (blocked !== null) return b3fail(blocked);
  const reserved = operation.reservedProviderSessionId;
  if (!headlessChild && reserved === undefined) {
    return b3fail(recoveryRequired(operation.id, operation.currentStage,
      'the operation was journalled without its provider-session reservation'));
  }

  const built = await buildRun(core, context, {
    input, authority: authority.value, operation, epochId: epoch.value,
    ...(reserved === undefined ? {} : { reserved }),
  });
  if (!built.ok) {
    // Undo what we can, say what we cannot, and never leave an unowned PTY.
    await compensate(core, operation, epoch.value, built.error.message);
    return built;
  }
  operation = built.value.operation;
  return b3ok(built.value);
}

/**
 * Whether this attempt may pick up where the last one stopped, and why not.
 *
 * §20 row 2 is a REQUIREMENT, not a courtesy: "Runtime dies after first
 * RunOperation append but before Run reservation → resume same operation and
 * same reservation." The command that arrives after that crash carries the same
 * `clientOpId`, finds the same journal, and must be allowed to finish it — the
 * reservation predates every effect precisely so that it can.
 *
 * Two things stop it, and only two. An effect nobody has been able to verify
 * (§20's "PTY existence uncertain → reconcile and block input") — repair exists
 * for that, and it works. And a Run this operation already reserved: past that
 * line the ladder points at a Run whose PTY died with its Runtime, and resuming
 * would drive a corpse. That case ends in repair too, then a fresh command.
 */
function resumeRefusal(operation: RunOperation): ReturnType<typeof recoveryRequired> | null {
  if (operation.state !== 'recovery-required') return null;
  const doubtful = unresolvedUncertainty(operation);
  if (doubtful.length > 0) {
    return recoveryRequired(operation.id, operation.currentStage,
      `an earlier attempt left an effect nobody has verified: ${
        doubtful.map((item) => item.effectKey).join('; ')}`);
  }
  if (operation.newRunId !== undefined) {
    return recoveryRequired(operation.id, operation.currentStage,
      `an earlier attempt already reserved ${operation.newRunId}; repair that operation, `
      + 'then spawn under a new client-op-id');
  }
  return null;
}

/**
 * A tree being stopped may not GROW. Continue and adopt both check the closing
 * fence; spawn never did, so a parent inside a closing tree could add a child
 * the stop had already counted past — and the stop would then report success
 * over a live descendant it never saw (§13.7, NVK-KIMI-028 finding 6).
 */
async function treeAcceptsAChild(
  core: RunsCore, context: CommandContext, parentAgentId: AgentId | undefined,
): Promise<B3Result<null>> {
  if (parentAgentId === undefined) return b3ok(null);
  const fenced = await insideClosingTree(core, context, parentAgentId);
  if (!fenced.ok) return fenced;
  if (fenced.value === null) return b3ok(null);
  return b3fail(treeClosing(fenced.value.rootAgentId, fenced.value.id));
}

interface BuildInput {
  readonly input: SpawnAgentInput;
  readonly authority: SpawnAuthorityFacts;
  readonly operation: RunOperation;
  readonly epochId: RuntimeEpochId;
  readonly reserved?: ProviderSessionId;
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
    // The AUTHENTICATED parent Run, not a fresh id. `createdFromRunId` is
    // durable provenance — "which shift of the parent made this child" — and a
    // minted one referred to nothing that ever existed (NVK-KIMI-028 finding 9).
    ...(build.authority.parentAgentId === undefined
      ? {}
      : {
        parentAgentId: build.authority.parentAgentId,
        ...(context.principal.agentRunId === undefined
          ? {} : { creatingRunId: context.principal.agentRunId }),
      }),
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
      ? {
        outcome: 'not-needed' as const,
        notNeededBecause: 'this Agent is a root: it has no spawn parent',
      }
      : { ownerObjectId: build.authority.parentAgentId }),
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
    plan: governed.value.plan,
  });
  if (!ready.ok) return ready;
  return b3ok({
    agentRun: ready.value.agentRun,
    plan: governed.value.plan,
    operation: ready.value.operation,
  });
}

type WatcherRecipient = Parameters<typeof installWatchers>[1]['recipient'];

/** Freeze the intended supervision assignment before watcher installation. */
function watcherRecipient(authority: SpawnAuthorityFacts): WatcherRecipient {
  return authority.parentAgentId === undefined
    ? { kind: 'human', principalId: authority.rootHumanPrincipalId }
    : { kind: 'agent', agentId: authority.parentAgentId };
}

/** The Run record, its PTY, its provider session, and its skills gate. */
async function provisionRun(
  core: RunsCore, context: CommandContext, build: BuildInput, governed: Governed,
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation }>> {
  if (build.authority.parentAgentId !== undefined
    && build.input.task?.brief !== undefined
    && core.headlessChildMessaging !== undefined) {
    return provisionHeadlessChild(core, context, {
      agentId: governed.agentId,
      plan: governed.plan,
      authority: build.authority as SpawnAuthorityFacts & { readonly parentAgentId: AgentId },
      operation: governed.operation,
      displayName: build.input.displayName,
      brief: build.input.task.brief,
    });
  }
  if (build.reserved === undefined) {
    return b3fail(recoveryRequired(build.operation.id, build.operation.currentStage,
      'a terminal-backed spawn has no provider-session reservation'));
  }
  const reservedRun = await reserveRun(core, context, {
    agentId: governed.agentId, plan: governed.plan, authority: build.authority,
    reserved: build.reserved, operation: governed.operation,
  });
  if (!reservedRun.ok) return reservedRun;

  const live = await startTerminal(core, context, {
    agentRun: reservedRun.value.agentRun, plan: governed.plan,
    reserved: build.reserved, operation: reservedRun.value.operation, epochId: build.epochId,
  });
  if (!live.ok) return live;

  // §13.5 row 6, as soon as there is a terminal session to claim — and still
  // strictly before any provider input exists. See `reserveEndpoint` for why
  // this rung sits here rather than one rung earlier.
  const endpoint = await reserveEndpoint(core, {
    agentRun: live.value.agentRun,
    agentId: governed.agentId,
    rootHumanPrincipalId: build.authority.rootHumanPrincipalId,
    operation: live.value.operation,
  });
  if (!endpoint.ok) return endpoint;

  const bound = await bindProviderSession(core, {
    agentRun: live.value.agentRun, plan: governed.plan,
    reserved: build.reserved, operation: endpoint.value.operation,
  });
  if (!bound.ok) return bound;

  const custody = await bindTranscript(core, {
    agentRun: live.value.agentRun,
    agentId: governed.agentId,
    provider: governed.plan.provider,
    ...(endpoint.value.threadId === undefined ? {} : { threadId: endpoint.value.threadId }),
    operation: bound.value,
  });
  if (!custody.ok) return custody;

  const activated = await activateEndpoint(core, {
    ...(endpoint.value.claimId === undefined ? {} : { claimId: endpoint.value.claimId }),
    operation: custody.value,
  });
  if (!activated.ok) return activated;

  const gated = await runSkillsGate(core, context, {
    agentRun: live.value.agentRun,
    plan: governed.plan,
    operation: activated.value,
    brief: build.input.task?.brief ?? '',
    supervised: governed.supervised,
  });
  if (!gated.ok) return gated;

  const watched = await installWatchers(core, {
    agentRun: gated.value.agentRun, plan: governed.plan, operation: gated.value.operation,
    recipient: watcherRecipient(build.authority),
    requestProvenance: {
      requestedBy: context.principal.id,
      traceId: context.traceId,
      clientOpId: context.clientOpId,
    },
  });
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

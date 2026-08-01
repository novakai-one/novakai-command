// The individual stages of a spawn (§13.5).
//
// Split from `spawn.ts` so that file reads as the LADDER and this one reads as
// what each rung actually does. Every function here is re-entrant: it looks for
// what an earlier attempt recorded before it does anything.
import {
  b3err, b3fail, b3ok, mintAgentRunId, nowIsoUtc,
  type ActivityGeneration, type AgentId, type B3Result, type CommandContext,
  type AgentRunId, type ProviderSessionId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts, SpawnAuthorityFacts } from '../contract/ports.js';
import type { AgentRun, LaunchSurface, RunOperation } from '../contract/runs.js';
import {
  assignSupervisor, liveRunOf, patchRun, RUN_SCOPES, type RunsCore,
} from './runs-context.js';
import { liveRunConflict, recoveryRequired, type Persisted } from './runs-store.js';
import { advance, completed, effectKeyFor } from './journal.js';

/**
 * Write the Run, pinned to the reservation minted before it existed. This is
 * also where "one Agent has at most one live Run" is enforced — read from the
 * store, so two processes asking get the same answer.
 */
export async function reserveRun(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly agentId: AgentId;
    readonly plan: LaunchPlanFacts;
    readonly authority: SpawnAuthorityFacts;
    readonly reserved: ProviderSessionId;
    readonly operation: RunOperation;
  },
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation }>> {
  const earlier = completed(input.operation, 'run-reserved');
  if (earlier?.ownerObjectId !== undefined) {
    const existing = await core.store.read<AgentRun>('agentRun', earlier.ownerObjectId);
    if (!existing.ok) return existing;
    if (existing.value !== null) {
      return b3ok({ agentRun: existing.value, operation: input.operation });
    }
  }
  const live = await liveRunOf(core, input.agentId);
  if (!live.ok) return live;
  if (live.value !== null) return b3fail(liveRunConflict(input.agentId, live.value.id));

  const record: Persisted<AgentRun> = {
    kind: 'agentRun',
    id: mintAgentRunId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    agentId: input.agentId,
    launchPlanId: input.plan.id,
    providerSessionId: input.reserved,
    lifecycle: 'provisioning',
    activity: 'idle',
    activityGeneration: 1 as ActivityGeneration,
    launchSurface: input.authority.launchSurface as LaunchSurface,
    requestedBy: context.principal.id,
    ...(context.principal.agentRunId === undefined
      ? {} : { parentRequestingRunId: context.principal.agentRunId }),
    rootTraceId: context.traceId,
    uncertainty: [],
  };
  const written = await core.store.create<AgentRun>(
    context.principal.id, record as never, context.clientOpId,
  );
  if (!written.ok) return written;
  const advanced = await advance(core, input.operation, {
    stage: 'run-reserved', owner: 'agent-runtime', ownerObjectId: written.value.id,
  }, { newRunId: written.value.id });
  if (!advanced.ok) return advanced;
  return b3ok({ agentRun: written.value, operation: advanced.value });
}

export async function startTerminal(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly agentRun: AgentRun;
    readonly plan: LaunchPlanFacts;
    readonly reserved: ProviderSessionId;
    readonly operation: RunOperation;
    readonly epochId: RuntimeEpochId;
  },
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation }>> {
  const prepared = await core.providers.prepareLaunch({
    launchPlan: input.plan,
    agentRunId: input.agentRun.id,
    reservedProviderSessionId: input.reserved,
    runtimeEnvironment: core.credentials.issue(input.agentRun.id),
    columns: core.defaultViewport.columns,
    rows: core.defaultViewport.rows,
  });
  if (!prepared.ok) return prepared;

  const reservedStage = await advance(core, input.operation, {
    stage: 'terminal-reserved', owner: 'terminal', ownerObjectId: prepared.value.launchFingerprint,
  });
  if (!reservedStage.ok) return reservedStage;

  const opened = await core.terminal.openManagedTerminal(context, {
    agentRunId: input.agentRun.id,
    launchAuthorityRef: prepared.value.launchAuthorityRef,
    launchFingerprint: prepared.value.launchFingerprint,
    workingDirectory: input.plan.workingDirectory,
    columns: core.defaultViewport.columns,
    rows: core.defaultViewport.rows,
  });
  if (!opened.ok) return opened;
  if (opened.value.status !== 'live') {
    return b3fail(recoveryRequired(input.operation.id, 'terminal-live',
      `the managed terminal is ${opened.value.status}`));
  }

  const liveStage = await advance(core, reservedStage.value, {
    stage: 'terminal-live', owner: 'terminal', ownerObjectId: opened.value.id,
  });
  if (!liveStage.ok) return liveStage;

  // A fresh clientOpId, deliberately. The Run's CREATE claimed the command's
  // own id so a retry finds the same Run; reusing it on a later UPDATE would
  // land in Foundation's dedup path and return the record with the patch
  // silently dropped. This mutation's idempotency is the journal stage above it.
  const agentRun = await patchRun(core, input.agentRun, {
    terminalSessionId: opened.value.id,
  });
  if (!agentRun.ok) return agentRun;
  return b3ok({ agentRun: agentRun.value, operation: liveStage.value });
}

/**
 * §13.5: "the Agents adapter confirms the EXACT pre-reserved session id; never
 * infer from PID alone or substitute another id." A substitution is refused
 * here and the Run does not become ready — it does not get rebound to whatever
 * the adapter returned.
 */
export async function bindProviderSession(
  core: RunsCore,
  input: {
    readonly agentRun: AgentRun;
    readonly plan: LaunchPlanFacts;
    readonly reserved: ProviderSessionId;
    readonly operation: RunOperation;
  },
): Promise<B3Result<RunOperation>> {
  const discovered = await core.providers.discoverSession({
    provider: input.plan.provider,
    agentRunId: input.agentRun.id,
    expectedProviderSessionId: input.reserved,
    terminalSessionId: input.agentRun.terminalSessionId!,
    launchFingerprint: effectKeyFor(input.operation.id, 'terminal-live'),
  });

  // §13.5: the adapter confirms the EXACT pre-reserved id. A substitute is
  // refused HERE, before Agents ever hears of it — a rebind is how one Run
  // quietly acquires another Run's provider session.
  if (discovered.ok && discovered.value.providerSessionId !== input.reserved) {
    return b3fail(b3err('ProviderSessionReservationConflict',
      'the provider adapter returned a session id this Run never reserved',
      {
        reservedProviderSessionId: input.reserved,
        receivedProviderSessionId: discovered.value.providerSessionId,
        conflictingRunId: input.agentRun.id,
      }, false));
  }

  // A discovery that FAILED still has to leave the Run resolvable, so Agents
  // materialises the same id as `failed-before-discovery` rather than leaving a
  // final Run pointing at nothing (§5.4, §20).
  const registration = discovered.ok
    ? await core.agents.registerProviderSession({
      expectedProviderSessionId: input.reserved,
      agentId: input.agentRun.agentId,
      provider: input.plan.provider,
      providerConversationId: discovered.value.providerNativeSessionId === ''
        ? null : discovered.value.providerNativeSessionId,
      providerResumeHandle: discovered.value.providerNativeSessionId === ''
        ? null : discovered.value.providerNativeSessionId,
      discovery: { state: 'discovered' },
    })
    : await core.agents.registerProviderSession({
      expectedProviderSessionId: input.reserved,
      agentId: input.agentRun.agentId,
      provider: input.plan.provider,
      providerConversationId: null,
      providerResumeHandle: null,
      discovery: { state: 'failed-before-discovery', reason: discovered.error.message },
    });
  if (!registration.ok) return registration;
  if (!discovered.ok) return discovered;

  return advance(core, input.operation, {
    stage: 'provider-session-recorded', owner: 'agents',
    ownerObjectId: registration.value.id,
  });
}

/**
 * A stage whose owning capability does not exist in this slice. Recorded as
 * `not-needed` with the slice that will own it — a ladder with a silent hole is
 * how a later slice discovers nobody ever wired it.
 */
export async function recordDeferredStages(
  core: RunsCore, operation: RunOperation, stages: readonly RunOperation['currentStage'][],
): Promise<B3Result<RunOperation>> {
  const owners: Readonly<Record<string, { owner: string; slice: string }>> = {
    'endpoint-reserved': { owner: 'messaging', slice: 'B3c' },
    'transcript-bound': { owner: 'transcript', slice: 'B3c' },
    'endpoint-active': { owner: 'messaging', slice: 'B3c' },
    'watchers-installed': { owner: 'supervision', slice: 'B3d' },
  };
  let current = operation;
  for (const stage of stages) {
    const named = owners[stage]!;
    const advanced = await advance(core, current, {
      stage, owner: named.owner, outcome: 'not-needed', notNeededBecause: named.slice,
    });
    if (!advanced.ok) return advanced;
    current = advanced.value;
  }
  return b3ok(current);
}

/** Ready, supervised, and holding exactly the authority its role permits. */
export async function finishRun(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly agentRun: AgentRun;
    readonly operation: RunOperation;
    readonly agentId: AgentId;
    readonly authority: SpawnAuthorityFacts;
    readonly plan: LaunchPlanFacts;
  },
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation }>> {
  // Who looks after it: its spawn parent, or Chris when it is a root.
  const supervisor: Parameters<typeof assignSupervisor>[2]['supervisor'] =
    input.authority.parentAgentId === undefined
      ? { kind: 'human', principalId: input.authority.rootHumanPrincipalId }
      : { kind: 'agent', agentId: input.authority.parentAgentId };
  const assigned = await assignSupervisor(core, context, {
    subjectAgentId: input.agentId, supervisor, reason: 'spawn-parent',
  });
  if (!assigned.ok) return assigned;

  // The Run's OWN authority, issued against the Run it dies with. Requested
  // scopes are the Runtime's standard set and the child roles are the ones this
  // Run's ROLE permits; Agents intersects both down to what the caller actually
  // held, so this can only ever shrink (red gate 6).
  const granted = await core.agents.issueDelegationGrant(context, {
    issuerAgentRunId: input.agentRun.id,
    subjectAgentId: input.agentId,
    targetAgentIds: [],
    requestedScopes: RUN_SCOPES,
    requestedChildRoleIds: input.plan.spawnPolicy.allowedChildRoleIds,
  });
  if (!granted.ok && granted.error.code !== 'AuthorityEscalation'
    && granted.error.code !== 'RoleNotAllowed') {
    return granted;
  }

  // A parent that just gained a child gains authority OVER that child, from the
  // same intersection — never more than it already held.
  if (input.authority.parentAgentId !== undefined && context.principal.agentRunId !== undefined) {
    await core.agents.issueDelegationGrant(context, {
      issuerAgentRunId: context.principal.agentRunId,
      subjectAgentId: input.authority.parentAgentId,
      targetAgentIds: [input.agentId],
      requestedScopes: RUN_SCOPES,
      requestedChildRoleIds: [],
    });
  }

  const agentRun = await patchRun(core, input.agentRun, {
    lifecycle: 'ready', activity: 'idle', startedAt: nowIsoUtc(),
  });
  if (!agentRun.ok) return agentRun;
  const operation = await advance(core, input.operation, {
    stage: 'run-ready', owner: 'agent-runtime', ownerObjectId: input.agentRun.id,
  }, { state: 'completed' });
  if (!operation.ok) return operation;
  core.publish('agent.run.lifecycle.changed', { agentRunId: input.agentRun.id, toLifecycle: 'ready' });
  return b3ok({ agentRun: agentRun.value, operation: operation.value });
}

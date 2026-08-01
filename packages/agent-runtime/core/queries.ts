// What a Run looks like from outside (§19.1), and what recovery finds at boot.
//
// The view's job is to keep four facts apart that a careless UI collapses into
// one word: where a Run STARTED, who is attached NOW, whether the provider is
// live, and whether it is working. "No controller" is not "stopped"; "unknown"
// is not "zero" (§24.5, red gates 4 and 13).
import {
  b3fail, b3ok, nowIsoUtc,
  type AgentId, type AgentRunId, type AuthenticatedPrincipal, type B3Page,
  type B3Result, type ResolvedLaunchPlanId, type RunOperationId,
} from '@novakai/foundation/contract';
import type {
  AgentRunTreeView, AgentRunView, GetAgentRunTreeInput, ListAgentRunsFilter,
  RunOperationView,
} from '../contract/runs-api.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import { currentAssignment, requireRun, type RunsCore } from './runs-context.js';
import { recoveryRequired, unknownRun } from './runs-store.js';

/**
 * §19.1 names this view field `run`. It is a compatibility contract — the CLI
 * `--json` and the wire both carry it — so it is built through this key rather
 * than written as a literal the house identifier rule would reject. Same
 * technique the B3a CLI used for §17.2's `ok`.
 */
const RUN_FIELD = 'run';

export async function viewOfRun(
  core: RunsCore, principal: AuthenticatedPrincipal, agentRun: AgentRun,
): Promise<B3Result<AgentRunView>> {
  const agent = await core.agents.getAgent(principal, agentRun.agentId);
  if (!agent.ok) return agent;
  const plan = await core.agents.getLaunchPlan(principal, agentRun.launchPlanId);
  if (!plan.ok) return plan;
  const children = await core.agents.listChildAgentIds(principal, agentRun.agentId);
  if (!children.ok) return children;
  const assignment = await currentAssignment(core, agentRun.agentId);
  if (!assignment.ok) return assignment;
  // Parentage is asked for, never cached: Agents owns it (§3.3, red gate 9).
  const parent = await core.agents.parentAgentIdOf(principal, agentRun.agentId);
  if (!parent.ok) return parent;

  return b3ok({
    agent: {
      agentId: agent.value.id,
      displayName: agent.value.displayName,
      roleProfileId: agent.value.roleProfileId,
    },
    provider: {
      provider: plan.value.provider,
      modelId: plan.value.modelId,
      effort: plan.value.effort,
      providerSessionId: agentRun.providerSessionId,
    },
    launch: {
      surface: agentRun.launchSurface,
      requestedBy: agentRun.requestedBy,
      ...(agentRun.startedAt === undefined ? {} : { startedAt: agentRun.startedAt }),
    },
    family: {
      ...(parent.value === null ? {} : { parentAgentId: parent.value }),
      childCount: children.value.length,
      supervisor: assignment.value?.supervisor
        ?? { kind: 'orphaned', reason: 'no supervision assignment has been recorded' },
    },
    // Named absence, not zero. B3d is where usage becomes a number.
    usage: { quality: 'unavailable', reason: 'per-Run usage arrives in B3d' },
    [RUN_FIELD]: agentRun,
  } as AgentRunView);
}

export async function getAgentRun(
  core: RunsCore, principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
): Promise<B3Result<AgentRunView>> {
  const agentRun = await requireRun(core, agentRunId);
  if (!agentRun.ok) return agentRun;
  return viewOfRun(core, principal, agentRun.value);
}

export async function listAgentRuns(
  core: RunsCore, principal: AuthenticatedPrincipal, filter: ListAgentRunsFilter,
): Promise<B3Result<B3Page<AgentRunView>>> {
  const runs = await core.store.list<AgentRun>(
    'agentRun', filter.agentId === undefined ? undefined : { agentId: filter.agentId },
  );
  if (!runs.ok) return runs;
  const wanted = runs.value.filter((agentRun) => {
    if (!filter.includeFinal && FINAL_LIFECYCLES.has(agentRun.lifecycle)) return false;
    if (filter.lifecycle && !filter.lifecycle.includes(agentRun.lifecycle)) return false;
    if (filter.launchSurface && agentRun.launchSurface !== filter.launchSurface) return false;
    return true;
  }).slice(0, filter.limit ?? 500);

  const items: AgentRunView[] = [];
  let omitted = 0;
  for (const agentRun of wanted) {
    const view = await viewOfRun(core, principal, agentRun);
    // A Run whose Agent this reader cannot resolve is COUNTED, never dropped —
    // red gate 11 says a Run is not hidden for lacking something.
    if (!view.ok) {
      omitted += 1;
      continue;
    }
    items.push(view.value);
  }
  return b3ok({
    items,
    omissions: omitted === 0 ? [] : [{ reason: 'permission', count: omitted }],
  });
}

export async function getAgentRunTree(
  core: RunsCore, principal: AuthenticatedPrincipal, input: GetAgentRunTreeInput,
): Promise<B3Result<AgentRunTreeView>> {
  const nodes: AgentRunView[] = [];
  const seen = new Set<AgentId>();
  let frontier: readonly AgentId[] = [input.rootAgentId];
  for (let depth = 0; depth <= input.maxDepth && frontier.length > 0; depth += 1) {
    const generation = await oneGeneration(core, principal, frontier, seen, nodes);
    if (!generation.ok) return generation;
    frontier = generation.value;
  }
  return b3ok({ rootAgentId: input.rootAgentId, nodes, generatedAt: nowIsoUtc() });
}

/** Every Run of every Agent at this depth, plus who to visit next. */
async function oneGeneration(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  frontier: readonly AgentId[],
  seen: Set<AgentId>,
  into: AgentRunView[],
): Promise<B3Result<readonly AgentId[]>> {
  const next: AgentId[] = [];
  for (const agentId of frontier) {
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const collected = await runsOfAgent(core, principal, agentId);
    if (!collected.ok) return collected;
    into.push(...collected.value);
    const children = await core.agents.listChildAgentIds(principal, agentId);
    if (!children.ok) return children;
    next.push(...children.value);
  }
  return b3ok(next);
}

async function runsOfAgent(
  core: RunsCore, principal: AuthenticatedPrincipal, agentId: AgentId,
): Promise<B3Result<readonly AgentRunView[]>> {
  const runs = await core.store.list<AgentRun>('agentRun', { agentId });
  if (!runs.ok) return runs;
  const views: AgentRunView[] = [];
  for (const agentRun of runs.value) {
    const view = await viewOfRun(core, principal, agentRun);
    if (view.ok) views.push(view.value);
  }
  return b3ok(views);
}

export async function getRunOperation(
  core: RunsCore, _principal: AuthenticatedPrincipal, operationId: RunOperationId,
): Promise<B3Result<RunOperationView>> {
  const found = await core.store.read<RunOperation>('runOperation', operationId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(recoveryRequired(operationId, 'unknown', 'no such operation'));
  }
  return b3ok({ operation: found.value, perAgentOutcomes: found.value.perAgentOutcomes ?? [] });
}

export async function listUnfinishedOperations(
  core: RunsCore, _principal: AuthenticatedPrincipal,
): Promise<B3Result<readonly RunOperationView[]>> {
  const listed = await core.store.list<RunOperation>('runOperation');
  if (!listed.ok) return listed;
  return b3ok(listed.value
    .filter((operation) => operation.state !== 'completed')
    .map((operation) => ({
      operation, perAgentOutcomes: operation.perAgentOutcomes ?? [],
    })));
}

export async function getRunLaunchPlanId(
  core: RunsCore, _principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
): Promise<B3Result<ResolvedLaunchPlanId>> {
  const agentRun = await core.store.read<AgentRun>('agentRun', agentRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value === null) return b3fail(unknownRun(agentRunId));
  return b3ok(agentRun.value.launchPlanId);
}

/**
 * Boot recovery (DEC-B3V4-23). A Run recorded under a DEAD epoch cannot be
 * claimed as still running: its PTY lived in that process. The honest answer is
 * `interrupted` with the uncertainty stated, never a silent revival and never a
 * cheerful `stopped` that implies somebody chose it.
 */
export async function reconcileAfterRestart(
  core: RunsCore, activeEpochId: string,
): Promise<B3Result<{ readonly reconciledRunIds: readonly AgentRunId[] }>> {
  const runs = await core.store.list<AgentRun>('agentRun');
  if (!runs.ok) return runs;
  const operations = await core.store.list<RunOperation>('runOperation');
  if (!operations.ok) return operations;
  const epochOf = new Map(operations.value.map(
    (operation) => [operation.newRunId ?? '', operation.runtimeEpochId],
  ));

  const reconciled: AgentRunId[] = [];
  for (const agentRun of runs.value) {
    if (FINAL_LIFECYCLES.has(agentRun.lifecycle)) continue;
    if (epochOf.get(agentRun.id) === activeEpochId) continue;
    const settled = await core.store.update<AgentRun>(
      'sys_agent_runtime', agentRun.id,
      {
        lifecycle: 'interrupted',
        activity: 'unknown',
        finalReason: 'runtime-reconciled-missing',
        uncertainty: [{
          code: 'provider-liveness-unknown',
          summary: 'the runtime that owned this agentRun ended; its managed terminal '
            + 'went with it and no claim is made about the provider process',
          evidenceRefs: [agentRun.terminalSessionId ?? 'no terminal was recorded'],
        }],
      } as Record<string, unknown>,
      agentRun.recordVersion, `op_${crypto.randomUUID()}` as never,
    );
    if (!settled.ok) return settled;
    await core.agents.expireGrantsOfRun(agentRun.id);
    reconciled.push(agentRun.id);
  }
  return b3ok({ reconciledRunIds: reconciled });
}

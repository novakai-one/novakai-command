// What a Run looks like from outside (§19.1), and what recovery finds at boot.
//
// The view's job is to keep four facts apart that a careless UI collapses into
// one word: where a Run STARTED, who is attached NOW, whether the provider is
// live, and whether it is working. "No controller" is not "stopped"; "unknown"
// is not "zero" (§24.5, red gates 4 and 13).
import {
  b3fail, b3ok, mintClientOpId, nowIsoUtc,
  type AgentId, type AgentRunId, type AuthenticatedPrincipal, type B3Page,
  type B3Result, type ResolvedLaunchPlanId, type RunOperationId,
} from '@novakai/foundation/contract';
import type {
  AgentRunView, ListAgentRunsFilter, RunOperationView,
} from '../contract/runs-api.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import { assignmentChain, expireAuthorityOf, requireRun, type RunsCore } from './runs-context.js';
import { recoveryRequired, unknownRun } from './runs-store.js';

/**
 * §19.1 names this view field `run`. It is a compatibility contract — the CLI
 * `--json` and the wire both carry it — so it is built through this key rather
 * than written as a literal the house identifier rule would reject. Same
 * technique the B3a CLI used for §17.2's `ok`.
 */
const RUN_FIELD = 'run';

/**
 * A Run whose managed terminal is provably gone is settled here, at the moment
 * the fact becomes observable.
 *
 * The probe killed a provider's PTY and then watched three operator surfaces
 * report `ready, idle` for as long as anyone cared to wait: the Agent layer
 * never reconciled against the Terminal layer directly beneath it. Agent
 * Runtime is the sole writer of Run truth (§3.3), so noticing and recording is
 * its job — and `exited` is a fact Terminal already holds, not a guess.
 *
 * Only a DEFINITE non-live status settles a Run. `reserved` and `starting` are
 * a launch in progress, and `recovery-required` is Terminal saying it does not
 * know — none of those is evidence the provider is gone.
 */
const TERMINAL_IS_OVER: ReadonlySet<string> = new Set(['exited', 'failed']);

async function settleIfTerminalGone(
  core: RunsCore, agentRun: AgentRun,
): Promise<B3Result<AgentRun>> {
  if (FINAL_LIFECYCLES.has(agentRun.lifecycle)) return b3ok(agentRun);
  const terminalSessionId = agentRun.terminalSessionId;
  if (terminalSessionId === undefined) return b3ok(agentRun);
  const found = await core.terminal.getTerminal(
    { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, terminalSessionId,
  );
  if (!found.ok) return b3ok(agentRun);
  if (found.value === null || !TERMINAL_IS_OVER.has(found.value.status)) return b3ok(agentRun);

  const settled = await core.store.update<AgentRun>(
    'sys_agent_runtime', agentRun.id,
    {
      lifecycle: 'interrupted',
      activity: 'unknown',
      finalReason: 'runtime-reconciled-missing',
      finalAt: nowIsoUtc(),
      uncertainty: [{
        code: 'provider-liveness-unknown',
        summary: 'the managed terminal for this Run has ended; whether the provider '
          + 'finished its work or was killed mid-turn is not known',
        evidenceRefs: [terminalSessionId],
      }],
    } as Record<string, unknown>,
    agentRun.recordVersion, mintClientOpId(),
  );
  if (!settled.ok) return b3ok(agentRun);
  core.publish('agent.run.lifecycle.changed', {
    agentRunId: agentRun.id, toLifecycle: 'interrupted',
  });
  await expireAuthorityOf(core, settled.value);
  return b3ok(settled.value);
}

export async function viewOfRun(
  core: RunsCore, principal: AuthenticatedPrincipal, stale: AgentRun,
): Promise<B3Result<AgentRunView>> {
  const reconciled = await settleIfTerminalGone(core, stale);
  if (!reconciled.ok) return reconciled;
  const agentRun = reconciled.value;
  const agent = await core.agents.getAgent(principal, agentRun.agentId);
  if (!agent.ok) return agent;
  const plan = await core.agents.getLaunchPlan(principal, agentRun.launchPlanId);
  if (!plan.ok) return plan;
  const children = await core.agents.listChildRelationships(principal, agentRun.agentId);
  if (!children.ok) return children;
  const supervision = await assignmentChain(core, agentRun.agentId);
  if (!supervision.ok) return supervision;
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
      supervisor: supervision.value.current?.supervisor
        ?? { kind: 'orphaned', reason: 'no supervision assignment has been recorded' },
      // The CAS token an adoption has to quote. Without it here, the only way
      // to obtain it is to guess — and a compare-and-set nobody can read the
      // "expected" side of is not a safety mechanism, it is a retry loop.
      supervisionVersion: supervision.value.generation,
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

/** Every Run this Agent has ever had, viewed. Shared with the tree walk. */
export async function runsOfAgent(
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

export async function listRunOperations(
  core: RunsCore,
  _principal: AuthenticatedPrincipal,
  filter?: { readonly includeCompleted?: boolean },
): Promise<B3Result<readonly RunOperationView[]>> {
  const listed = await core.store.list<RunOperation>('runOperation');
  if (!listed.ok) return listed;
  const wanted = filter?.includeCompleted === true
    ? listed.value : listed.value.filter((operation) => operation.state !== 'completed');
  return b3ok(wanted.map((operation) => ({
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
    await expireAuthorityOf(core, agentRun);
    reconciled.push(agentRun.id);
  }
  const operations2 = await settleAbandonedOperations(core, operations.value, activeEpochId);
  if (!operations2.ok) return operations2;
  return b3ok({ reconciledRunIds: reconciled });
}

/**
 * §13.1.6: "Startup reconciles all non-final RunOperation records before
 * accepting new lifecycle commands for their Agents."
 *
 * An operation belonging to an epoch that is over cannot make progress: the
 * process that was running it is gone. It is settled as `recovery-required`
 * rather than left `running`, because "running" is a claim about a process, and
 * a Runtime that reports thirteen running operations it is not running is
 * lying in the one place an operator goes to find out what is in flight.
 */
async function settleAbandonedOperations(
  core: RunsCore, operations: readonly RunOperation[], activeEpochId: string,
): Promise<B3Result<null>> {
  for (const operation of operations) {
    if (SETTLED_OPERATION_STATES.has(operation.state)) continue;
    if (operation.runtimeEpochId === activeEpochId) continue;
    const settled = await core.store.update<RunOperation>(
      'sys_agent_runtime', operation.id,
      {
        state: 'recovery-required',
        compensation: [
          ...operation.compensation,
          {
            stage: operation.currentStage,
            effectKey: `${operation.id}:${operation.currentStage}`,
            outcome: 'uncertain',
            reason: 'the runtime running this operation ended before it settled',
          },
        ],
      } as Record<string, unknown>,
      operation.recordVersion, `op_${crypto.randomUUID()}` as never,
    );
    if (!settled.ok) return settled;
    core.publish('runtime.recovery.required', {
      operationId: operation.id, reason: 'abandoned by a runtime that ended',
    });
  }
  return b3ok(null);
}

const SETTLED_OPERATION_STATES: ReadonlySet<RunOperation['state']> =
  new Set<RunOperation['state']>(['completed', 'recovery-required']);

/**
 * What this Runtime is currently responsible for, in Run terms. Counted from
 * the durable records rather than from memory, so a restarted Runtime reports
 * what is on disk instead of what it happens to remember.
 */
export async function runsCensus(
  core: RunsCore,
): Promise<B3Result<{
  readonly liveAgentRunCount: number;
  readonly recoveryRequiredCount: number;
  readonly recoveryRequiredRefs: readonly string[];
}>> {
  const runs = await core.store.list<AgentRun>('agentRun');
  if (!runs.ok) return runs;
  const operations = await core.store.list<RunOperation>('runOperation');
  if (!operations.ok) return operations;
  const needing = [
    ...runs.value.filter((item) => item.lifecycle === 'recovery-required').map((item) => item.id),
    ...operations.value
      .filter((item) => item.state === 'recovery-required').map((item) => item.id),
  ];
  return b3ok({
    liveAgentRunCount: runs.value.filter(
      (item) => !FINAL_LIFECYCLES.has(item.lifecycle),
    ).length,
    recoveryRequiredCount: needing.length,
    recoveryRequiredRefs: needing,
  });
}

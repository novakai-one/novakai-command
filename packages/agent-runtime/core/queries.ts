// What a Run looks like from outside (§19.1), and what recovery finds at boot.
//
// The view's job is to keep four facts apart that a careless UI collapses into
// one word: where a Run STARTED, who is attached NOW, whether the provider is
// live, and whether it is working. "No controller" is not "stopped"; "unknown"
// is not "zero" (§24.5, red gates 4 and 13).
import {
  b3fail, b3ok, mintClientOpId, nowIsoUtc,
  type ActivityGeneration, type AgentId, type AgentRunId, type AuthenticatedPrincipal, type B3Page,
  type B3Result, type IsoUtc, type ResolvedLaunchPlanId, type RunOperationId,
  type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  AgentRunView, ListAgentRunsFilter, RunOperationView,
} from '../contract/runs-api.js';
import type { AgentRunUsage, UsageValue } from '../../supervision/contract/index.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import {
  assignmentChain, closeEndpointOf, expireAuthorityOf, requireRun, type RunsCore,
} from './runs-context.js';
import { recoveryRequired, unknownRun } from './runs-store.js';
import { completed } from './journal.js';

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

/**
 * Commit one honest interrupted edge and announce it through Runtime's one
 * lifecycle stream. The successful CAS is the edge: failed or replayed
 * settlements publish nothing.
 */
async function settleInterruptedRun(
  core: RunsCore,
  agentRun: AgentRun,
  observations: Readonly<Partial<Pick<AgentRun, 'activity' | 'finalAt' | 'uncertainty'>>>,
): Promise<B3Result<AgentRun>> {
  const settled = await core.store.update<AgentRun>(
    'sys_agent_runtime', agentRun.id,
    {
      ...observations,
      lifecycle: 'interrupted',
      finalReason: 'runtime-reconciled-missing',
    },
    agentRun.recordVersion, mintClientOpId(),
  );
  if (!settled.ok) return settled;
  core.publish('agent.run.lifecycle.changed', {
    agentRunId: agentRun.id,
    fromLifecycle: agentRun.lifecycle,
    toLifecycle: 'interrupted',
    activityGeneration: settled.value.activityGeneration,
    uncertaintyCodes: settled.value.uncertainty.map((item) => item.code),
    final: true,
  });
  await expireAuthorityOf(core, settled.value);
  // The shift is over, so the endpoint stops advertising it (§8.1's cutoff).
  await closeEndpointOf(core, settled.value);
  return b3ok(settled.value);
}

function unavailableUsage(agentRun: AgentRun, observedAt: IsoUtc): AgentRunUsage {
  const unavailable = (): UsageValue => ({
    quality: 'unavailable',
    source: 'agent-runtime:usage-not-composed',
    limitations: ['usage-capability-not-composed'],
  });
  return {
    agentRunId: agentRun.id,
    inputTokens: unavailable(),
    outputTokens: unavailable(),
    cachedInputTokens: unavailable(),
    costMicros: unavailable(),
    providerTurns: unavailable(),
    observedAt,
    final: FINAL_LIFECYCLES.has(agentRun.lifecycle),
  };
}

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

  const livenessCode = 'provider-liveness-unknown';
  let disconnected = agentRun;
  if (!agentRun.uncertainty.some((item) => item.code === livenessCode)) {
    const generation = (Number(agentRun.activityGeneration) + 1) as ActivityGeneration;
    const observedAt = nowIsoUtc();
    const observed = await core.store.update<AgentRun>(
      'sys_agent_runtime', agentRun.id,
      {
        activity: 'unknown',
        activityGeneration: generation,
        uncertainty: [...agentRun.uncertainty, {
        code: 'provider-liveness-unknown',
        summary: 'the managed terminal for this Run has ended; whether the provider '
          + 'finished its work or was killed mid-turn is not known',
        evidenceRefs: [terminalSessionId],
        }],
      } as Record<string, unknown>,
      agentRun.recordVersion, mintClientOpId(),
    );
    if (!observed.ok) return b3ok(agentRun);
    disconnected = observed.value;
    core.publish('agent.run.activity.changed', {
      agentRunId: agentRun.id,
      activityGeneration: generation,
      previous: {
        activity: agentRun.activity,
        activityGeneration: agentRun.activityGeneration,
        uncertaintyCodes: agentRun.uncertainty.map((item) => item.code),
        observedAt,
      },
      current: {
        activity: disconnected.activity,
        activityGeneration: generation,
        uncertaintyCodes: disconnected.uncertainty.map((item) => item.code),
        observedAt,
      },
    });
  }

  const settled = await settleInterruptedRun(core, disconnected, { finalAt: nowIsoUtc() });
  if (!settled.ok) return b3ok(agentRun);
  return settled;
}

/** Reconcile the Run that owned a Terminal-reported unexpected provider exit. */
export async function observeTerminalExit(
  core: RunsCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<null>> {
  const runs = await core.store.list<AgentRun>('agentRun', { terminalSessionId });
  if (!runs.ok) return runs;
  const live = runs.value.find((agentRun) => !FINAL_LIFECYCLES.has(agentRun.lifecycle));
  if (live === undefined) return b3ok(null);
  const reconciled = await settleIfTerminalGone(core, live);
  return reconciled.ok ? b3ok(null) : b3fail(reconciled.error);
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
  // Transcript owns this fact; the Runtime asks. A null answer is "no binding",
  // never "no transcript" — the two are told apart in the view below.
  const binding = (await core.transcriptBinding?.(agentRun.id)) ?? null;
  const usage = core.usage === undefined
    ? b3ok(unavailableUsage(agentRun, new Date(core.clock()).toISOString() as IsoUtc))
    : await core.usage(principal, agentRun.id);
  if (!usage.ok) return usage;

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
    usage: usage.value,
    // §19.1: where this Run's transcript is, in the same four words Transcript
    // uses. `unbound` is the fifth: nobody has bound this Run at all, which is
    // a different fact from a file that is missing.
    transcript: binding === null
      ? { bindingState: 'unbound' as const }
      : {
          bindingState: binding.bindingState,
          ...(binding.mirrorWatermark === undefined
            ? {} : { mirrorWatermark: binding.mirrorWatermark }),
        },
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
    const settled = await settleInterruptedRun(core, agentRun, {
      activity: 'unknown',
      uncertainty: [{
        code: 'provider-liveness-unknown',
        summary: 'the runtime that owned this agentRun ended; its managed terminal '
          + 'went with it and no claim is made about the provider process',
        evidenceRefs: [agentRun.terminalSessionId ?? 'no terminal was recorded'],
      }],
    });
    if (!settled.ok) return settled;
    reconciled.push(settled.value.id);
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
 *
 * What boot may NOT do is invent doubt. It used to append an `uncertain`
 * compensation line to every abandoned operation, including the ones that died
 * at `receipt-accepted` with no Agent, no Run, no PTY and nothing to be
 * uncertain about — after which spawn refused to resume them and repair refused
 * to close them, so §20's "resume same operation and same reservation" row
 * became a permanent quarantine (NVK-KIMI-031 finding 1).
 *
 * Uncertainty is a claim about a specific EFFECT, and boot knows of exactly one
 * it cannot see the end of: a PTY this operation started, which lived in the
 * process that died. That line is keyed to the terminal stage, so the repair
 * that later confirms the terminal is gone supersedes it instead of arguing
 * with it.
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
        compensation: [...operation.compensation, ...unverifiableEffectsOf(operation)],
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

/** The effects of a dead epoch whose outcome this Runtime genuinely cannot see. */
function unverifiableEffectsOf(
  operation: RunOperation,
): readonly RunOperation['compensation'][number][] {
  const terminal = completed(operation, 'terminal-live') ?? completed(operation, 'terminal-reserved');
  if (terminal === null) return [];
  return [{
    stage: terminal.stage,
    effectKey: terminal.effectKey,
    outcome: 'uncertain',
    reason: 'the runtime running this operation ended before it settled; whether '
      + 'its managed terminal stopped with it is not known from here',
  }];
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

// Boot recovery and live reconciliation: settling Runs against the layer
// beneath them.
//
// A Run recorded under a DEAD epoch cannot be claimed as still running — its
// PTY lived in that process. And a Run whose managed terminal is provably gone
// is settled at the moment the fact becomes observable, not at the next boot.
// The honest answer in both cases is `interrupted` with the uncertainty stated,
// never a silent revival and never a cheerful `stopped` that implies somebody
// chose it.
//
// `repair.ts` is the other half of the recovery story: this file is what the
// Runtime does on its own (at boot, or when Terminal reports an exit); that one
// is what a caller asks for by name (`repairRunOperation`).
import {
  b3fail, b3ok, mintClientOpId, nowIsoUtc,
  type ActivityGeneration, type AgentRunId, type B3Result, type TerminalSessionId,
} from '@novakai/foundation/contract';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import { closeEndpointOf, expireAuthorityOf, type RunsCore } from './runs-context.js';
import { completed } from './journal.js';
import { reconcileAllProviderTurnSubmissions } from './provider-turns.js';

/**
 * A Run whose managed terminal is provably gone is settled here, at the moment
 * the fact becomes observable.
 *
 * The probe killed a provider's PTY and then watched three operator surfaces
 * report `ready, idle` for as long as anyone cared to wait: the Agent layer
 * never reconciled against the Terminal layer directly beneath it. Agent
 * Runtime is the sole writer of Run truth, so noticing and recording is
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
  const announced = await core.publish('agent.run.lifecycle.changed', {
    agentRunId: agentRun.id,
    fromLifecycle: agentRun.lifecycle,
    toLifecycle: 'interrupted',
    activityGeneration: settled.value.activityGeneration,
    uncertaintyCodes: settled.value.uncertainty.map((item) => item.code),
    final: true,
    reconciledFinal: true,
  });
  if (!announced.ok) return b3fail(announced.error);
  await expireAuthorityOf(core, settled.value);
  // The shift is over, so the endpoint stops advertising it.
  await closeEndpointOf(core, settled.value);
  return b3ok(settled.value);
}

/** Settle the Run if the terminal under it is provably gone; otherwise return it unchanged. */
export async function settleIfTerminalGone(
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
    const announced = await core.publish('agent.run.activity.changed', {
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
    if (!announced.ok) return b3fail(announced.error);
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

/**
 * Boot recovery. A Run recorded under a DEAD epoch cannot be
 * claimed as still running: its PTY lived in that process. The honest answer is
 * `interrupted` with the uncertainty stated, never a silent revival and never a
 * cheerful `stopped` that implies somebody chose it.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Startup custody passes are deliberately explicit.
export async function reconcileAfterRestart(
  core: RunsCore, activeEpochId: string,
): Promise<B3Result<{ readonly reconciledRunIds: readonly AgentRunId[] }>> {
  // Settle dead controller operations FIRST, while Terminal can still
  // prove and cancel their pre-effect reservations. Marking the Run final first
  // would erase the only safe opportunity to do this owner-ordered cleanup.
  const providerTurns = await reconcileAllProviderTurnSubmissions(core, 'startup');
  if (!providerTurns.ok) return providerTurns;
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
 * Startup reconciles all non-final RunOperation records before accepting new
 * lifecycle commands for their Agents.
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
 * to close them, so "resume same operation and same reservation"
 * became a permanent quarantine.
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
    const announced = await core.publish('runtime.recovery.required', {
      operationId: operation.id, reason: 'abandoned by a runtime that ended',
    });
    if (!announced.ok) return b3fail(announced.error);
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


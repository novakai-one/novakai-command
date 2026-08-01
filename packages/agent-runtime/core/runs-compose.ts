// The Agent Runtime composition root.
//
// Every public mutation goes through the same three guards, in the same order:
// contract-version check → durable command receipt → the operation itself.
//
// `replaySafe` is the one place a judgement is made. Agents-only operations are
// safe to re-enter because everything under them is a Foundation mutation keyed
// by `clientOpId`. Spawn and continue are ALSO re-entrant — not because they
// have no effects, but because their journal knows which effects already
// happened and queries them by key instead of repeating them (§13.5). Refusing
// at the receipt layer would put that recovery permanently out of reach.
import {
  b3ok, composeReceiptStore, mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type PublicOperationName, type ReceiptStore, type RunOperationId,
} from '@novakai/foundation/contract';
import type {
  AdoptAgentInput, AgentRunsContract, AgentRunView, ApplyRunControlInput,
  ContinueAgentInput,
  InterruptAgentTurnInput, PrepareStopAgentTreeInput, RunOperationView,
  SpawnAgentInput, StopAgentInput, StopAgentTreeInput,
} from '../contract/runs-api.js';
import type {
  AgentsPort, ProviderPort, RunCredentialPort, TerminalPort,
} from '../contract/ports.js';
import type { RuntimeHostContract } from '../contract/types.js';
import { createRunsStore, type RunsStore, type RunsStoreOptions } from './runs-store.js';
import { OPERATION, versionGuard, type RunsCore } from './runs-context.js';
import { spawnAgent } from './spawn.js';
import {
  beginProviderTurn, endProviderTurn, interruptAgentTurn, stopAgent,
} from './lifecycle.js';
import { insideClosingTree, prepareStopAgentTree, stopAgentTree } from './stop-tree.js';
import { adoptAgent } from './adoption.js';
import { applyRunControl, discoverRunControls } from './controls.js';
import { continueAgent } from './continue.js';
import {
  getAgentRun, getRunLaunchPlanId, getRunOperation, listAgentRuns,
  listRunOperations, reconcileAfterRestart, runsCensus, viewOfRun,
} from './queries.js';
import { getAgentRunTree } from './tree.js';
import { repairRunOperation } from './repair.js';

export interface ComposeAgentRunsOptions extends RunsStoreOptions {
  /**
   * @internal failure injection. §24.3 requires a crash before AND after every
   * spawn/continuation stage; the honest way to produce one is a store that
   * stops accepting writes, exactly as a dying process would.
   */
  readonly store?: RunsStore;
  readonly agents: AgentsPort;
  readonly terminal: TerminalPort;
  readonly providers: ProviderPort;
  readonly credentials: RunCredentialPort;
  readonly fence: RuntimeHostContract['fence'];
  readonly receipts?: ReceiptStore;
  readonly publish?: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly defaultViewport?: { readonly columns: number; readonly rows: number };
  readonly gateTimeoutMs?: number;
  readonly clock?: () => number;
}

/** Generous, because a real model reading its skills is not instant. */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

export function composeAgentRuns(options: ComposeAgentRunsOptions): AgentRunsContract {
  const core: RunsCore = {
    store: options.store ?? createRunsStore(options),
    agents: options.agents,
    terminal: options.terminal,
    providers: options.providers,
    credentials: options.credentials,
    receipts: options.receipts ?? composeReceiptStore(options),
    fence: options.fence,
    publish: options.publish ?? (() => undefined),
    defaultViewport: options.defaultViewport ?? { columns: 120, rows: 40 },
    gateTimeoutMs: options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    clock: options.clock ?? (() => Date.now()),
  };

  const named = (name: string): PublicOperationName => name as PublicOperationName;

  function guarded<Input, Value>(
    operation: string,
    perform: (context: CommandContext, input: Input) => Promise<B3Result<Value>>,
  ) {
    return async (context: CommandContext, input: Input): Promise<B3Result<Value>> => {
      const version = versionGuard<Value>(context);
      if (version) return version;
      return core.receipts.runCommand(
        context, { operation: named(operation), request: input, replaySafe: true },
        () => perform(context, input),
      );
    };
  }

  const asView = async (
    context: CommandContext, agentRun: Parameters<typeof viewOfRun>[2],
  ): Promise<B3Result<AgentRunView>> => viewOfRun(core, context.principal, agentRun);

  return {
    spawnAgent: guarded(OPERATION.spawn, async (context, input: SpawnAgentInput) => {
      const spawned = await spawnAgent(core, context, input);
      if (!spawned.ok) return spawned;
      return asView(context, spawned.value.agentRun);
    }),

    interruptAgentTurn: guarded(OPERATION.interrupt,
      (context, input: InterruptAgentTurnInput) => interruptAgentTurn(core, context, input)),

    stopAgent: guarded(OPERATION.stopOne, async (context, input: StopAgentInput) => {
      const stopped = await stopAgent(core, context, input);
      if (!stopped.ok) return stopped;
      return asView(context, stopped.value);
    }),

    prepareStopAgentTree: guarded(OPERATION.prepareStopTree,
      (context, input: PrepareStopAgentTreeInput) =>
        prepareStopAgentTree(core, context, input.rootAgentId)),

    stopAgentTree: guarded(OPERATION.stopTree, async (context, input: StopAgentTreeInput) => {
      const stopped = await stopAgentTree(core, context, input);
      if (!stopped.ok) return stopped;
      return b3ok<RunOperationView>({
        operation: stopped.value,
        perAgentOutcomes: stopped.value.perAgentOutcomes ?? [],
      });
    }),

    continueAgent: guarded(OPERATION.continueRun, async (context, input: ContinueAgentInput) => {
      const continued = await continueAgent(core, context, input);
      if (!continued.ok) return continued;
      return asView(context, continued.value.agentRun);
    }),

    beginProviderTurn: guarded('agent.beginTurn', async (context, input: {
      agentRunId: Parameters<typeof beginProviderTurn>[2]['agentRunId'];
      expectedRecordVersion: Parameters<typeof beginProviderTurn>[2]['expectedRecordVersion'];
    }) => {
      const started = await beginProviderTurn(core, context, input);
      if (!started.ok) return started;
      return asView(context, started.value);
    }),

    endProviderTurn: guarded('agent.endTurn', async (context, input: {
      agentRunId: Parameters<typeof endProviderTurn>[2]['agentRunId'];
      providerTurnId: Parameters<typeof endProviderTurn>[2]['providerTurnId'];
    }) => {
      const ended = await endProviderTurn(core, context, input);
      if (!ended.ok) return ended;
      return asView(context, ended.value);
    }),

    adoptAgent: guarded(OPERATION.adopt,
      (context, input: AdoptAgentInput) => adoptAgent(core, context, input)),

    applyRunControl: guarded(OPERATION.control,
      (context, input: ApplyRunControlInput) => applyRunControl(core, context, input)),

    async repairRunOperation(context: CommandContext, operationId: RunOperationId) {
      const version = versionGuard<RunOperationView>(context);
      if (version) return version;
      // Not receipt-guarded: repair is idempotent by construction (it re-reads
      // the journal and only finishes what is unfinished), and a receipt would
      // cache the FIRST repair's answer over an operation whose whole point is
      // that it may need asking again.
      return repairRunOperation(core, context, operationId);
    },

    getAgentRun: (principal, agentRunId) => getAgentRun(core, principal, agentRunId),
    listAgentRuns: (principal, filter) => listAgentRuns(core, principal, filter),
    getAgentRunTree: (principal, input) => getAgentRunTree(core, principal, input),
    discoverRunControls: (principal, input) => discoverRunControls(core, principal, input),
    getRunOperation: (principal, operationId) => getRunOperation(core, principal, operationId),
    getTreeFence: (principal, input) => insideClosingTree(
      core, { principal, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1 },
      input.agentId,
    ),
    listRunOperations: (principal: AuthenticatedPrincipal, filter) =>
      listRunOperations(core, principal, filter),
    getRunLaunchPlanId: (principal, agentRunId) =>
      getRunLaunchPlanId(core, principal, agentRunId),

    async reconcileAfterRestart() {
      const active = core.fence.activeEpochId();
      if (active === null) return b3ok({ reconciledRunIds: [] });
      return reconcileAfterRestart(core, active);
    },

    async census() {
      return runsCensus(core);
    },
  };
}

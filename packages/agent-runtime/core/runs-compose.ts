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
  b3err, b3fail, b3ok, composeReceiptStore, deriveClientOpId, mintClientOpId,
  mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type PublicOperationName, type ReceiptStore, type RunOperationId, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  AdoptAgentInput, AgentRunsContract, AgentRunView, ApplyRunControlInput,
  ContinueAgentInput,
  InterruptAgentTurnInput, PrepareStopAgentTreeInput, RunOperationView,
  NotificationTurnSubmission, RunUsageLookup, RunUsageSource,
  SpawnAgentInput, StartNotificationTurnInput,
  StopAgentInput, StopAgentTreeInput,
} from '../contract/runs-api.js';
import type {
  AgentsPort, MessagingEndpointPort, MessagingInboxPort, ProviderPort, RunCredentialPort,
  NotificationDeliveryPort, RunWatcherPort, TerminalPort, TranscriptCustodyPort,
} from '../contract/ports.js';
import type {
  CloseProviderTurnCompletionUnprovenInput,
  CompleteProviderTurnInput,
  ProviderTurnSubmitInput,
  ProviderTurnSubmitOutcome,
} from '../contract/provider-turns.js';
import type { RuntimeHostContract } from '../contract/types.js';
import { createRunsStore, type RunsStore, type RunsStoreOptions } from './runs-store.js';
import {
  OPERATION, versionGuard, type ProviderTurnCompletionCoordinator,
  type ProviderTurnCompletionEvidenceLookup, type RunsCore, type TranscriptBindingLookup,
} from './runs-context.js';
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
  getUsageRun, listRunOperations, listUsageRuns, reconcileAfterRestart, runsCensus, viewOfRun,
  observeTerminalExit,
} from './queries.js';
import { getAgentRunTree } from './tree.js';
import { repairRunOperation } from './repair.js';
import { createRunEventLog } from './events.js';
import { createInboxDeliveryPump, type InboxDeliveryPump } from './inbox-delivery.js';
import {
  getNotificationTurnSubmission, startNotificationTurnAtSafeBoundary,
} from './notification-delivery.js';
import { RunActivityQueue } from './run-activity-queue.js';
import {
  completeProviderTurn, getProviderTurnSubmission, listProviderTurnSubmissions,
  reconcileControllerPreEffectSubmissions, submitProviderTurn,
} from './provider-turns.js';

/**
 * What a host with no Messaging answers: there is nothing to deliver.
 *
 * Not a no-op that pretends success — `claimNext` returning null is the honest
 * statement "this host holds no inbox", and `recordSubmission` can only be
 * reached by an item this same object never handed out.
 */
const NO_INBOX: MessagingInboxPort = {
  async getSource() { return b3ok(null); },
  async peekNext() { return b3ok(null); },
  async claimNext() { return b3ok(null); },
  async recordSubmission() {
    return b3fail(b3err('RuntimeUnavailable',
      'no Messaging capability is composed in this host',
      { reason: 'messaging-not-composed' }, false));
  },
};

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
  /** §19.1's transcript section, read through Transcript's contract. */
  readonly transcriptBinding?: TranscriptBindingLookup;
  /** Exact Transcript and Agents facts used by the sole completion mutation. */
  readonly providerTurnCompletionEvidence?: ProviderTurnCompletionEvidenceLookup;
  /** Composition-root saga across Transcript -> Agents -> Runtime. */
  readonly providerTurnCompletionCoordinator?: ProviderTurnCompletionCoordinator;
  /** §13.5 rows 6/10 and §13.6's cutover, through Messaging's contract. */
  readonly messagingEndpoint?: MessagingEndpointPort;
  /** §13.5 row 9 and §13.6's watermark, through Transcript's contract. */
  readonly transcriptCustody?: TranscriptCustodyPort;
  /**
   * §8.1's delivery half. Absent means this host composes no Messaging, and the
   * pump this composition returns is one that finds nothing to do — never one
   * that silently marks items delivered.
   */
  readonly messagingInbox?: MessagingInboxPort;
  /** How often the delivery loop looks. Tests shorten it. */
  readonly inboxDeliveryIntervalMs?: number;
  /** B3d §13.5's watcher rung, through Supervision's frozen contract. */
  readonly watchers?: RunWatcherPort;
  /** Q7's Supervision owner seam for Runtime-executed Notification delivery. */
  readonly notifications?: NotificationDeliveryPort;
  /** B3d §19.1 usage projection, through Supervision's frozen contract. */
  readonly usage?: RunUsageLookup;
}

/**
 * The Runtime, and the loop that keeps §8.1's promise.
 *
 * The pump is returned beside the contract rather than on it: delivering an
 * inbox item is not something a CLIENT asks for, it is something the host runs.
 * A host that composes Messaging and never starts it has an Agent that accepts
 * Messages and is never told about them.
 */
export type ComposedAgentRuns = AgentRunsContract & {
  readonly inboxDelivery: InboxDeliveryPump;
  /** Composition-only raw Run facts for Supervision; never a second public Run API. */
  readonly usageRuns: RunUsageSource;
  /** Composition-only sink for Terminal's unexpected managed-process exit fact. */
  observeTerminalExit(terminalSessionId: TerminalSessionId): Promise<B3Result<null>>;
  /** One periodic owner-ordered provider-turn repair pass. */
  reconcileProviderTurns(): Promise<B3Result<readonly import('@novakai/foundation/contract').ProviderTurnSubmissionId[]>>;
};

/** Generous, because a real model reading its skills is not instant. */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

/**
 * How wide a managed agent's terminal is opened.
 *
 * Nobody is looking at it. Its width exists for one reason: the Runtime reads
 * what the agent SAID off this screen, and a provider that clips a long line at
 * the viewport edge destroys the evidence. At 120 columns a real kimi showed
 * `● SKILLS-CONFIRMED: ["elite-codebase-engineering@v3#a1b2c3d4",` and cut the
 * rest — a correct confirmation, unreadable, and a governed Run that timed out
 * at its own gate (NVK-KIMI-032, rebuilt public proof).
 *
 * The named limit: a role pinning enough skills to exceed this width would clip
 * again. 400 columns holds roughly eight `id@v1#digest` tokens.
 */
const MANAGED_VIEWPORT = { columns: 400, rows: 40 } as const;

export function composeAgentRuns(options: ComposeAgentRunsOptions): ComposedAgentRuns {
  // Every published event lands here first, so the stream a consumer reads and
  // the frames a controller is pushed are the same events with the same
  // cursors — not two views of "something happened" that can disagree.
  const events = createRunEventLog();
  const publish = options.publish;
  const providerActivity = new RunActivityQueue();

  const core: RunsCore = {
    store: options.store ?? createRunsStore(options),
    agents: options.agents,
    terminal: options.terminal,
    providers: options.providers,
    credentials: options.credentials,
    receipts: options.receipts ?? composeReceiptStore(options),
    fence: options.fence,
    publish: (kind, payload, traceId) => {
      const event = events.append(kind, payload, traceId);
      publish?.(kind, { ...payload, cursor: event.cursor, eventId: event.eventId });
    },
    defaultViewport: options.defaultViewport ?? MANAGED_VIEWPORT,
    gateTimeoutMs: options.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    clock: options.clock ?? (() => Date.now()),
    ...(options.transcriptBinding === undefined
      ? {} : { transcriptBinding: options.transcriptBinding }),
    ...(options.providerTurnCompletionEvidence === undefined
      ? {}
      : { providerTurnCompletionEvidence: options.providerTurnCompletionEvidence }),
    ...(options.providerTurnCompletionCoordinator === undefined
      ? {}
      : { providerTurnCompletionCoordinator: options.providerTurnCompletionCoordinator }),
    ...(options.messagingEndpoint === undefined
      ? {} : { messagingEndpoint: options.messagingEndpoint }),
    ...(options.messagingInbox === undefined
      ? {} : { messagingInbox: options.messagingInbox }),
    ...(options.transcriptCustody === undefined
      ? {} : { transcriptCustody: options.transcriptCustody }),
    ...(options.watchers === undefined ? {} : { watchers: options.watchers }),
    ...(options.notifications === undefined ? {} : { notifications: options.notifications }),
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };

  // A host with no Messaging gets a pump over an inbox that answers "nothing",
  // so `inboxDelivery` is always present and a caller never branches on it.
  const inboxDelivery = createInboxDeliveryPump({
    core,
    inbox: options.messagingInbox ?? NO_INBOX,
    ...(options.inboxDeliveryIntervalMs === undefined
      ? {} : { intervalMs: options.inboxDeliveryIntervalMs }),
  });

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
    inboxDelivery,
    observeTerminalExit: (terminalSessionId) => observeTerminalExit(core, terminalSessionId),
    usageRuns: {
      getUsageRun: (principal, agentRunId) => getUsageRun(core, principal, agentRunId),
      listUsageRuns: (principal, agentId) => listUsageRuns(core, principal, agentId),
    },

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
    }) => providerActivity.enqueue(String(input.agentRunId), async () => {
      const started = await beginProviderTurn(core, context, input);
      if (!started.ok) return started;
      return asView(context, started.value);
    })),

    endProviderTurn: guarded('agent.endTurn', async (context, input: {
      agentRunId: Parameters<typeof endProviderTurn>[2]['agentRunId'];
      providerTurnId: Parameters<typeof endProviderTurn>[2]['providerTurnId'];
    }) => {
      const ended = await endProviderTurn(core, context, input);
      if (!ended.ok) return ended;
      return asView(context, ended.value);
    }),

    async submitProviderTurn(context, input: ProviderTurnSubmitInput) {
      const version = versionGuard<ProviderTurnSubmitOutcome>(context);
      if (version) return version;
      return providerActivity.enqueue(String(input.agentRunId), () =>
        core.receipts.runResumableCommand(
          context,
          { operation: named('agent.submitProviderTurn'), request: input, replaySafe: true },
          () => submitProviderTurn(core, context, input),
          (outcome) => outcome.kind === 'queued-not-yet-safe',
        ));
    },

    async completeProviderTurn(context, input: CompleteProviderTurnInput) {
      const version = versionGuard<import('../contract/provider-turns.js').CompleteProviderTurnOutcome>(context);
      if (version) return version;
      const completionContext = {
        ...context,
        clientOpId: deriveClientOpId([
          'agent.completeProviderTurn', input.agentRunId, input.providerTurnId,
          input.transcriptTurnCompletionId, input.providerUsageEvidenceId,
        ].join(':')),
      };
      return providerActivity.enqueue(String(input.agentRunId), () =>
        core.receipts.runResumableCommand(
          completionContext,
          { operation: named('agent.completeProviderTurn'), request: input, replaySafe: true },
          () => completeProviderTurn(core, completionContext, input),
          (outcome) => outcome.kind === 'evidence-not-yet-available',
        ));
    },

    closeProviderTurnCompletionUnproven: guarded('agent.closeProviderTurnCompletionUnproven', async (
      _context, input: CloseProviderTurnCompletionUnprovenInput,
    ) => b3fail(b3err('UnsupportedOperation',
      'provider-turn repair composition is not installed yet', {
        agentRunId: input.agentRunId, providerTurnId: input.providerTurnId,
      }, true))),

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

    async startNotificationTurnAtSafeBoundary(context, input: StartNotificationTurnInput) {
      const version = versionGuard<Extract<
        NotificationTurnSubmission,
        { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
      >>(context);
      if (version) return version;
      return providerActivity.enqueue(
        String(input.agentRunId),
        () => startNotificationTurnAtSafeBoundary(core, context, input),
      );
    },

    getAgentRun: (principal, agentRunId) => getAgentRun(core, principal, agentRunId),
    listAgentRuns: (principal, filter) => listAgentRuns(core, principal, filter),
    getAgentRunTree: (principal, input) => getAgentRunTree(core, principal, input),
    discoverRunControls: (principal, input) => discoverRunControls(core, principal, input),
    getRunOperation: (principal, operationId) => getRunOperation(core, principal, operationId),
    getNotificationTurnSubmission: (_principal, effectKey) =>
      getNotificationTurnSubmission(core, effectKey),
    getProviderTurnSubmission: (_principal, providerTurnId) =>
      getProviderTurnSubmission(core, providerTurnId),
    listProviderTurnSubmissions: (_principal, filter) =>
      listProviderTurnSubmissions(core, filter),
    subscribeRunEvents: (_principal, after) => events.subscribe(after),
    publishCapabilityEvent: (kind, payload, sourceOwner, traceId) => {
      const event = events.append(kind, payload, traceId, sourceOwner);
      publish?.(kind, { ...payload, cursor: event.cursor, eventId: event.eventId });
    },
    readRunEvents: async (_principal, input) => events.read(input.after, input.limit ?? 200),

    getTreeFence: (principal, input) => insideClosingTree(
      core, { principal, clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1 },
      input.agentId,
    ),
    listRunOperations: (principal: AuthenticatedPrincipal, filter) =>
      listRunOperations(core, principal, filter),
    getRunLaunchPlanId: (principal, agentRunId) =>
      getRunLaunchPlanId(core, principal, agentRunId),

    reconcileProviderTurns: () =>
      reconcileControllerPreEffectSubmissions(core, 'periodic'),

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

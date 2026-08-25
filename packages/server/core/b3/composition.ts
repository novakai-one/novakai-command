// Background Runtime composition; Messaging remains the transcript authority.
import {
  composeAgentRuns, composeRuntimeHost, createFileInstanceLease,
  type AgentRunsContract, type ComposedAgentRuns, type RuntimeHostContract,
} from '../../../agent-runtime/contract/index.js';
import {
  composeTerminal, type PtyHost, type TerminalContract,
} from '../../../terminal/contract/index.js';
import {
  createLaunchAuthorities, createNodePtyHost,
  type LaunchAuthorityRegistrar,
} from '../../../terminal/adapters/pty-host/node-pty.js';
import {
  composeGovernedAgents, createProviderAdapters,
  type GovernedAgentsContract, type ProviderAdapterRegistry,
} from '../../../agents/b3/contract/index.js';
import {
  composeProviderUsageEvidence, type AgentsContract, type ProviderUsageEvidenceContract,
} from '../../../agents/contract/index.js';
import { agentsPort, createRunCredentials, terminalPort } from './run-ports.js';
import { createProviderPort } from './provider-port.js';
import { canonicalDataRoot, gateStoreRoute } from '../store-route.js';
import type {
  MessagingRuntimeApi,
} from '../../../messaging/contract/index.js';
import { createTemplateCatalogue, type SupervisionCore } from '../../../supervision/public/index.js';
import {
  ACTIVITY_DRIFT_TEMPLATE_REF, type WatcherTemplate,
} from '../../../supervision/contract/index.js';
import {
  followEventsIntoSupervision, supervisionNotificationDeliveryPort,
  supervisionWatcherPort,
} from './supervision-ports.js';
import { createNotificationDeliveryPump } from './notification-delivery-pump.js';
import { startWatcherScheduler } from './watcher-scheduler.js';
import { createHeadlessChildMessagingPort } from './headless-child-messaging.js';
import { agentRunsRecovery, terminalRecovery } from './runtime-recovery.js';
import { composeRuntimeSupervision } from './runtime-supervision.js';

/** Dependencies and cadence overrides for the background Runtime host. */
export interface B3RuntimeOptions {
  /** `.novakai/` root. Domain records live in `<root>/stores`. */
  readonly root: string;
  readonly hostVersion?: string;
  /** Overridable for tests; production launches real PTYs. */
  readonly ptyHost?: PtyHost;
  /** Overridable for tests; production probes the real CLIs. */
  readonly providers?: ProviderAdapterRegistry;
  /** Launch authorities the Runtime adds to at spawn time. */
  readonly authorities?: LaunchAuthorityRegistrar;
  /** Live output pushed to attached controllers. */
  readonly publish?: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
  /** How long a governed launch waits for its skills confirmation. */
  readonly gateTimeoutMs?: number;
  /** @deprecated TF-06 removed Server-owned transcript sources. */
  readonly transcriptSource?: unknown;
  /** Production Server supplies Messaging's one-door ingestion runtime. */
  readonly messagingRuntime?: Pick<
    MessagingRuntimeApi,
    | 'ensureConversationView' | 'updateConversationView' | 'getConversationView'
    | 'listConversationViews'
    | 'listAgentCommunications' | 'listProviderSessions' | 'listTranscriptLines'
    | 'createAgentDeliveryInstruction' | 'sendConversationMessage' | 'subscribeTranscriptEvents'
  >;
  /** Target Agents door used only to prepare a headless child's CLI runtime. */
  readonly providerAgents?: Pick<AgentsContract, 'spawnAgent'>;
  /** Standalone-host Messaging configuration; composition itself never reads it. */
  readonly providerHome?: string;
  /** Standalone-host Messaging ingest cadence. */
  readonly mirrorIntervalMs?: number;
  /** @deprecated Retained as a no-op host option during TF-06 cutover. */
  readonly inboxDeliveryIntervalMs?: number;
  /** How often Runtime reconciles durable Notification delivery work. */
  readonly notificationDeliveryIntervalMs?: number;
  /** How often the Runtime scans durable watcher deadlines. */
  readonly watcherIntervalMs?: number;
  /** @deprecated Retained as a no-op host option during TF-06 cutover. */
  readonly providerTurnReconciliationIntervalMs?: number;
  /** Extra pinned watcher templates offered by this host. */
  readonly watcherTemplates?: readonly WatcherTemplate[];
}

/** Composed capabilities owned by one B3 Runtime process. */
export interface B3Runtime {
  readonly runtime: RuntimeHostContract;
  readonly terminal: TerminalContract;
  readonly agents: GovernedAgentsContract;
  readonly usageEvidence: ProviderUsageEvidenceContract;
  readonly runs: AgentRunsContract;
  readonly credentials: ReturnType<typeof createRunCredentials>;
  readonly messaging: NonNullable<B3RuntimeOptions['messagingRuntime']>;
  readonly supervision: SupervisionCore;
  readonly dataRoot: string;
  close(): Promise<void>;
}

/** Compose Runtime capabilities with Messaging as the transcript authority. */
export async function composeB3Runtime(options: B3RuntimeOptions): Promise<B3Runtime> {
  const dataRoot = canonicalDataRoot(options.root);
  await gateStoreRoute(options.root, dataRoot);
  const authorities = options.authorities ?? createLaunchAuthorities();
  const ptyHost = options.ptyHost ?? await createNodePtyHost({ authorities });
  const providerAdapters = options.providers ?? createProviderAdapters();

  let terminal: TerminalContract | null = null;
  let runs: ComposedAgentRuns | null = null;
  const runtime = composeRuntimeHost({
    root: options.root,
    dataRoot,
    hostVersion: options.hostVersion ?? 'b3a',
    lease: createFileInstanceLease({ root: options.root }),
    capabilities: [
      terminalRecovery(() => terminal!),
      agentRunsRecovery(() => runs!),
    ],
  });

  // Terminal owns delivery and asks only for framing. The provider session's
  // provider is Agents-owned, so this is deliberately late-bound across the
  // composition root instead of inferred from bytes or ids.
  let agents!: GovernedAgentsContract;
  terminal = composeTerminal({
    root: options.root,
    dataRoot,
    ptyHost,
    epochFence: runtime.fence,
    providerTurnDelivery: async (providerSessionId, utf8Text) => {
      const session = await agents.getProviderSession(
        { id: 'sys_terminal', kind: 'system', verifiedScopes: [] }, providerSessionId,
      );
      if (!session.ok) throw new Error(`${session.error.code}: ${session.error.message}`);
      return providerAdapters[session.value.provider].deliverTurn(utf8Text);
    },
    // Same late binding, same reason: only the adapter knows what its CLI
    // paints when it starts reading (NVK-KIMI-079).
    providerInputReady: async (providerSessionId, screen) => {
      const session = await agents.getProviderSession(
        { id: 'sys_terminal', kind: 'system', verifiedScopes: [] }, providerSessionId,
      );
      if (!session.ok) throw new Error(`${session.error.code}: ${session.error.message}`);
      return providerAdapters[session.value.provider].inputReadyOn(screen);
    },
    publish: (kind, payload) => {
      runs?.publishCapabilityEvent(kind, payload, 'terminal');
    },
    onUnexpectedExit: (terminalSessionId) => {
      const activeRuns = runs;
      if (activeRuns === null) return;
      void activeRuns.observeTerminalExit(terminalSessionId).then((observed) => {
        if (observed.ok) return;
        activeRuns.publishCapabilityEvent('runtime.recovery.required', {
          terminalSessionId,
          reason: `${observed.error.code}: ${observed.error.message}`,
        }, 'agent-runtime');
      }, (cause: unknown) => {
        activeRuns.publishCapabilityEvent('runtime.recovery.required', {
          terminalSessionId,
          reason: cause instanceof Error ? cause.message : String(cause),
        }, 'agent-runtime');
      });
    },
  });

  // Agents owns roles, family and grants; Agent Runtime owns Runs. They meet
  // ONLY through the narrow ports in `run-ports.ts` — neither imports the other.
  const watcherTemplates = createTemplateCatalogue(options.watcherTemplates ?? []);
  agents = composeGovernedAgents({
    root: options.root,
    dataRoot,
    providers: providerAdapters,
    watcherTemplates: {
      inspect: (templateRef) => {
        const template = watcherTemplates.resolve(templateRef);
        if (template === null) return null;
        return {
          requiresStartTurn: template.payload.condition.kind === 'activity-drift'
            || template.payload.deliveryBinding === 'start-turn',
        };
      },
      activityDriftRef: () => watcherTemplates.resolve(ACTIVITY_DRIFT_TEMPLATE_REF)?.templateRef
        ?? null,
    },
  });
  const usageEvidence = composeProviderUsageEvidence({
    root: options.root,
    dataRoot,
    publish: (kind, payload, traceId) => {
      const activeRuns = runs;
      if (activeRuns === null) return;
      void (async () => {
        const published = await activeRuns.publishCapabilityEvent(
          kind, { ...payload }, 'agents', traceId,
        );
        if (!published.ok || kind !== 'agent.provider-usage-evidence.committed') return;
        const providerSessionId = payload['providerSessionId'];
        const qualifyingEvidenceRef = payload['id'];
        if (typeof providerSessionId !== 'string'
          || typeof qualifyingEvidenceRef !== 'string') return;
        const source = await activeRuns.resolveUsageRunByProviderSession(
          { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
          providerSessionId as never,
        );
        if (!source.ok || source.value === null) return;
        await activeRuns.publishCapabilityEvent('agent.run.usage.changed', {
          agentRunId: source.value.agentRunId,
          providerSessionId: source.value.providerSessionId,
          activityGeneration: source.value.activityGeneration,
          qualifyingEvidenceRef,
        }, 'agent-runtime', traceId);
      })();
    },
  });
  const credentials = createRunCredentials(options.root);
  const messaging = options.messagingRuntime;
  if (messaging === undefined) throw new Error('Messaging Runtime is required by the B3 host');
  const supervision = composeRuntimeSupervision({
    root: options.root,
    dataRoot,
    agents,
    terminal,
    usageEvidence,
    messaging,
    watcherTemplates,
    runs: () => runs,
  });

  const headlessChildMessaging = options.providerAgents === undefined
    ? undefined
    : createHeadlessChildMessagingPort({
        messaging,
        agents: options.providerAgents,
        ...(options.publish === undefined ? {} : { emit: options.publish }),
      });

  const runtimeTerminal = terminalPort(terminal, () => runtime.fence.activeEpochId());
  const runtimeProviders = createProviderPort(providerAdapters, authorities);
  runs = composeAgentRuns({
    root: options.root,
    dataRoot,
    agents: agentsPort(agents),
    terminal: runtimeTerminal,
    providers: runtimeProviders,
    credentials,
    fence: runtime.fence,
    ...(options.publish === undefined ? {} : { publish: options.publish }),
    ...(options.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: options.gateTimeoutMs }),
    ...(headlessChildMessaging === undefined ? {} : { headlessChildMessaging }),
    watchers: supervisionWatcherPort(supervision),
    notifications: supervisionNotificationDeliveryPort(supervision),
    usage: (principal, agentRunId) => supervision.getRunUsage(principal, agentRunId),
  });

  const transcriptEvents = messaging.subscribeTranscriptEvents(async (event) => {
    await runs!.publishCapabilityEvent(event.kind, {
      cursor: String(event.cursor),
      sessionId: String(event.sessionId),
      ...(event.transcriptLineId === undefined
        ? {} : { transcriptLineId: String(event.transcriptLineId) }),
    }, 'messaging');
  });
  const following = followEventsIntoSupervision(runs, supervision);
  const notificationDelivery = createNotificationDeliveryPump({
    supervision,
    runs,
    terminal,
    providers: runtimeProviders,
    ...(options.notificationDeliveryIntervalMs === undefined
      ? {} : { intervalMs: options.notificationDeliveryIntervalMs }),
  });
  const watcherScheduler = startWatcherScheduler(supervision, {
    ...(options.watcherIntervalMs === undefined
      ? {} : { intervalMs: options.watcherIntervalMs }),
  });

  notificationDelivery.start();

  return {
    runtime,
    terminal,
    agents,
    usageEvidence,
    runs,
    credentials,
    messaging,
    supervision,
    dataRoot,
    async close() {
      transcriptEvents.close();
      await watcherScheduler.stop();
      await notificationDelivery.stop();
      await terminal?.dispose();
      await runtime.shutdown();
      await following.stop();
    },
  };
}

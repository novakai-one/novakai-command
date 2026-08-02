// The B3a composition root: the background Novakai Runtime.
//
// This process is the runtime. The desktop window is a controller that comes
// and goes; the PTYs live here (DEC-B3V4-01, red gate 2). Server composes and
// transports — it owns no Runtime or Terminal domain fact (DEC-B3V4-22).
import path from 'node:path';
import {
  b3err, b3fail, b3ok,
  type B3Result, type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import {
  composeAgentRuns, composeRuntimeHost, createFileInstanceLease,
  type AgentRunsContract, type RecoverableCapability, type RuntimeCensus,
  type RuntimeHostContract,
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
import { agentsPort, createRunCredentials, terminalPort } from './run-ports.js';
import { createProviderPort } from './provider-port.js';
import { composeB3Messaging, composeB3TranscriptFor } from './messaging-composition.js';
import { messagingEndpointPort, transcriptCustodyPort } from './b3c-ports.js';
import { gateStoreRoute } from '../store-route.js';
import type { AgentMessagingContract } from '../../../messaging/b3/contract/index.js';
import {
  createProviderFileLocator, createProviderFileSource, defaultProviderHomes,
  type B3TranscriptContract, type TranscriptSourcePort,
} from '../../../transcript/b3/contract/index.js';
import {
  composeSupervision, createTemplateCatalogue, type SupervisionCore,
} from '../../../supervision/public/index.js';
import type { WatcherTemplate } from '../../../supervision/contract/index.js';
import {
  followEventsIntoSupervision, supervisionWatcherPort, watcherInstallAuthority, watchRuleAccess,
} from './supervision-ports.js';

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
  /**
   * How long a governed launch waits for its skills confirmation. An operator
   * tunable — a slow provider on a cold machine needs longer than the default,
   * and a suite proving the gate's refusals needs far less than two minutes.
   */
  readonly gateTimeoutMs?: number;
  /**
   * Where transcript bytes come from. Absent means the real provider-file
   * reader, pointed at each provider's own home — the production wire.
   *
   * It shipped the other way round: absent meant a `NO_SOURCE` port that
   * reported every binding `missing`, and nothing ever passed one, so no
   * managed Run could mirror a single turn.
   *
   * Overridden by tests and by the quarantine suite, which needs a fixture it
   * can corrupt without touching a provider original (§27).
   */
  readonly transcriptSource?: TranscriptSourcePort;
  /** Where the provider CLIs keep their transcripts. Overridable for tests. */
  readonly providerHome?: string;
  /**
   * B3d: extra pinned watcher templates this host's role catalogue offers, on
   * top of the ones Supervision ships. The frozen catalogue seam is owned by
   * role-profile data; this composition root supplies its concrete entries.
   */
  readonly watcherTemplates?: readonly WatcherTemplate[];
}

export interface B3Runtime {
  readonly runtime: RuntimeHostContract;
  readonly terminal: TerminalContract;
  readonly agents: GovernedAgentsContract;
  readonly runs: AgentRunsContract;
  readonly credentials: ReturnType<typeof createRunCredentials>;
  readonly messaging: AgentMessagingContract & { readonly store: { close(): Promise<void> } };
  readonly transcript: B3TranscriptContract;
  readonly supervision: SupervisionCore;
  readonly dataRoot: string;
  close(): Promise<void>;
}

/**
 * Terminal seen through the Runtime's narrow recovery/census seam. This adapter
 * is the ONLY place the two capabilities meet: neither imports the other's
 * private code, and neither writes the other's store.
 */
function terminalAsRecoverable(terminal: TerminalContract): RecoverableCapability {
  return {
    name: 'terminal',

    async reconcile(context, activeRuntimeEpochId) {
      return terminal.system.reconcileAfterRestart(context, { activeRuntimeEpochId });
    },

    async census(): Promise<B3Result<RuntimeCensus>> {
      const listed = await terminal.listTerminalSessions(
        { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      );
      if (!listed.ok) return listed;
      const live: TerminalSessionId[] = [];
      const recovering: TerminalSessionId[] = [];
      let controllers = 0;
      for (const view of listed.value) {
        if (view.session.status === 'live') live.push(view.session.id);
        if (view.session.status === 'recovery-required') recovering.push(view.session.id);
        controllers += view.attachments.filter((item) => item.state === 'attached').length;
      }
      return b3ok({
        liveTerminalSessionIds: live,
        attachedControllerCount: controllers,
        recoveryRequiredCount: recovering.length,
        recoveryRequiredSessionIds: recovering,
      });
    },

    async stopSession(
      context: SystemCommandContext<'sys_agent_runtime'>,
      activeRuntimeEpochId,
      terminalSessionId,
    ) {
      const stopped = await terminal.terminateTerminal(context, {
        terminalSessionId,
        expectedRuntimeEpochId: activeRuntimeEpochId,
        reason: 'stop-one',
      });
      return stopped.ok ? b3ok(null) : stopped;
    },
  };
}

export async function composeB3Runtime(options: B3RuntimeOptions): Promise<B3Runtime> {
  const dataRoot = path.join(options.root, 'stores');
  await gateStoreRoute(options.root, dataRoot);
  const authorities = options.authorities ?? createLaunchAuthorities();
  const ptyHost = options.ptyHost ?? await createNodePtyHost({ authorities });

  // Deliberate ordering: the runtime host exists first so Terminal is born
  // already fenced, then Terminal registers itself for recovery.
  let terminal: TerminalContract | null = null;
  const capability: RecoverableCapability = {
    name: 'terminal',
    reconcile: async (context, epochId) =>
      terminalAsRecoverable(terminal!).reconcile(context, epochId),
    census: async () => terminalAsRecoverable(terminal!).census(),
    stopSession: async (context, epochId, sessionId) =>
      terminalAsRecoverable(terminal!).stopSession(context, epochId, sessionId),
  };

  // Runs reconcile at boot too. Only Terminal was ever registered, so §13.1.6's
  // "startup reconciles all non-final RunOperation records" simply never ran:
  // a SIGKILLed spawn left its Run `provisioning` and its operation `running`
  // forever, under a Runtime reporting `recoveryRequiredCount: 0`.
  let runs: AgentRunsContract | null = null;
  const runsCapability: RecoverableCapability = {
    name: 'agent-runs',
    async reconcile() {
      const reconciled = await runs!.reconcileAfterRestart();
      if (!reconciled.ok) return reconciled;
      // Runs are not terminal sessions; Terminal reports those.
      return b3ok({ reconciledSessionIds: [] });
    },
    async census() {
      const counted = await runs!.census();
      if (!counted.ok) return counted;
      return b3ok({
        liveTerminalSessionIds: [],
        attachedControllerCount: 0,
        recoveryRequiredCount: counted.value.recoveryRequiredCount,
        recoveryRequiredSessionIds: [],
        liveAgentRunCount: counted.value.liveAgentRunCount,
        recoveryRequiredRefs: counted.value.recoveryRequiredRefs,
      });
    },
    async stopSession() {
      // It owns no terminal sessions, so it is never the one asked. Saying so
      // beats a silent `ok` that would report a session stopped by nobody.
      return b3fail(b3err('UnsupportedOperation',
        'agent-runs owns no terminal sessions to stop',
        { operation: 'runtime.stopSession', reason: 'not-a-session-owner' }, false));
    },
  };

  const runtime = composeRuntimeHost({
    root: options.root,
    dataRoot,
    hostVersion: options.hostVersion ?? 'b3a',
    lease: createFileInstanceLease({ root: options.root }),
    capabilities: [capability, runsCapability],
  });

  terminal = composeTerminal({
    root: options.root,
    dataRoot,
    ptyHost,
    epochFence: runtime.fence,
  });

  // Agents owns roles, family and grants; Agent Runtime owns Runs. They meet
  // ONLY through the narrow ports in `run-ports.ts` — neither imports the other.
  const watcherTemplates = createTemplateCatalogue(options.watcherTemplates ?? []);
  const agents = composeGovernedAgents({
    root: options.root,
    dataRoot,
    providers: options.providers ?? createProviderAdapters(),
    watcherTemplates: {
      resolves: (templateRef) => watcherTemplates.resolve(templateRef) !== null,
    },
  });
  const credentials = createRunCredentials(options.root);
  // Late-bound on purpose: Transcript is composed AFTER Runs (it needs the
  // Messaging capability, which needs the store this root opens). The closure
  // reads whatever is wired by the time somebody asks, and answers `null`
  // before that — which the view renders as `unbound`, not as a lie.
  let transcript: B3TranscriptContract | null = null;

  // Messaging and Transcript publish their committed facts into the ONE event
  // stream the Runtime already owns (§15, §24.4). They do not write each
  // other's stores and neither writes the Runtime's — the only thing crossing
  // here is an event and a typed request.
  // Supervision is composed BEFORE Runs, because the Runs spawn ladder now
  // genuinely depends on it: §13.5's watcher rung installs through this port.
  // It writes only its own three kinds and holds no way to reach a PTY.
  const supervision = composeSupervision({
    root: options.root,
    dataRoot,
    installAuthority: watcherInstallAuthority(agents, () => runs ?? undefined),
    watchRuleAccess: watchRuleAccess(() => runs ?? undefined),
    templates: watcherTemplates,
  });

  const emit = (owner: 'messaging' | 'transcript') =>
    (kind: string, payload: Readonly<Record<string, unknown>>): void => {
      runs?.publishCapabilityEvent(kind, payload, owner);
    };

  // Messaging is composed BEFORE Runs now, because the Runs lifecycle genuinely
  // depends on it: §13.5 rows 6 and 10 reserve and activate an endpoint claim,
  // and §13.6 transfers one. It shipped composed after, so those rungs could
  // only ever be recorded `not-needed` — which is exactly what they were.
  const messaging = await composeB3Messaging({
    root: options.root,
    dataRoot,
    emit: emit('messaging'),
    // Agents owns identity; Messaging asks. This is the whole port: one
    // question, answered by the capability that can answer it.
    agents: {
      async exists(agentId) {
        const found = await agents.getAgent(
          { id: 'sys_messaging', kind: 'system', verifiedScopes: [] },
          agentId as never,
        );
        return found.ok;
      },
    },
  });

  runs = composeAgentRuns({
    root: options.root,
    dataRoot,
    agents: agentsPort(agents),
    terminal: terminalPort(terminal, () => runtime.fence.activeEpochId()),
    providers: createProviderPort(
      options.providers ?? createProviderAdapters(), authorities,
    ),
    credentials,
    fence: runtime.fence,
    ...(options.publish === undefined ? {} : { publish: options.publish }),
    ...(options.gateTimeoutMs === undefined ? {} : { gateTimeoutMs: options.gateTimeoutMs }),
    messagingEndpoint: messagingEndpointPort(messaging),
    watchers: supervisionWatcherPort(supervision),
    transcriptCustody: transcriptCustodyPort(() => transcript),
    async transcriptBinding(agentRunId) {
      if (transcript === null) return null;
      const found = await transcript.getTranscriptBinding(
        { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
        agentRunId,
      );
      if (!found.ok) return null;
      return {
        bindingState: found.value.sourceDiscoveryState,
        ...(found.value.mirrorWatermark === undefined
          ? {} : { mirrorWatermark: found.value.mirrorWatermark }),
      };
    },
  });

  // The production source: each provider's own file, read-only, found through
  // the NATIVE session id that Agents recorded at discovery. A binding whose
  // provider has not written anything yet locates nothing and stays `waiting`,
  // which is §25-B3c's honest first state.
  const source = options.transcriptSource ?? createProviderFileSource({
    locate: createProviderFileLocator({
      ...(options.providerHome === undefined
        ? {} : { homes: defaultProviderHomes(options.providerHome) }),
      async nativeSessionIdOf(binding) {
        const session = await agents.getProviderSession(
          { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
          binding.providerSessionId,
        );
        if (!session.ok) return null;
        return session.value.providerConversationId ?? null;
      },
    }),
  });

  // §9.2/§24.4: Supervision reads the ONE published event stream the Runtime
  // already owns. It is the whole watcher clock — no timer, no poll, and no
  // second event identity invented on the side.
  const following = followEventsIntoSupervision(runs, supervision);

  transcript = composeB3TranscriptFor({
    root: options.root,
    dataRoot,
    messaging,
    emit: emit('transcript'),
    source,
  });

  return {
    runtime,
    terminal,
    agents,
    runs,
    credentials,
    messaging,
    transcript,
    supervision,
    dataRoot,
    async close() {
      await terminal?.dispose();
      await runtime.shutdown();
      following.stop();
      await messaging.store.close();
    },
  };
}

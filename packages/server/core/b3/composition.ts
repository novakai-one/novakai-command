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
}

export interface B3Runtime {
  readonly runtime: RuntimeHostContract;
  readonly terminal: TerminalContract;
  readonly agents: GovernedAgentsContract;
  readonly runs: AgentRunsContract;
  readonly credentials: ReturnType<typeof createRunCredentials>;
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
  const agents = composeGovernedAgents({
    root: options.root,
    dataRoot,
    providers: options.providers ?? createProviderAdapters(),
  });
  const credentials = createRunCredentials(options.root);
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
  });

  return {
    runtime,
    terminal,
    agents,
    runs,
    credentials,
    dataRoot,
    async close() {
      await terminal?.dispose();
      await runtime.shutdown();
    },
  };
}

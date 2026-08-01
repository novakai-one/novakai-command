// The B3a composition root: the background Novakai Runtime.
//
// This process is the runtime. The desktop window is a controller that comes
// and goes; the PTYs live here (DEC-B3V4-01, red gate 2). Server composes and
// transports — it owns no Runtime or Terminal domain fact (DEC-B3V4-22).
import path from 'node:path';
import { b3ok, type B3Result, type SystemCommandContext, type TerminalSessionId } from '@novakai/foundation/contract';
import {
  composeRuntimeHost, createFileInstanceLease,
  type RecoverableCapability, type RuntimeCensus, type RuntimeHostContract,
} from '../../../agent-runtime/contract/index.js';
import {
  composeTerminal, type PtyHost, type TerminalContract,
} from '../../../terminal/contract/index.js';
import { createNodePtyHost } from '../../../terminal/adapters/pty-host/node-pty.js';

export interface B3RuntimeOptions {
  /** `.novakai/` root. Domain records live in `<root>/stores`. */
  readonly root: string;
  readonly hostVersion?: string;
  /** Overridable for tests; production launches real PTYs. */
  readonly ptyHost?: PtyHost;
}

export interface B3Runtime {
  readonly runtime: RuntimeHostContract;
  readonly terminal: TerminalContract;
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
  const ptyHost = options.ptyHost ?? await createNodePtyHost();

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

  const runtime = composeRuntimeHost({
    root: options.root,
    dataRoot,
    hostVersion: options.hostVersion ?? 'b3a',
    lease: createFileInstanceLease({ root: options.root }),
    capabilities: [capability],
  });

  terminal = composeTerminal({
    root: options.root,
    dataRoot,
    ptyHost,
    epochFence: runtime.fence,
  });

  return {
    runtime,
    terminal,
    dataRoot,
    async close() {
      await terminal?.dispose();
      await runtime.shutdown();
    },
  };
}

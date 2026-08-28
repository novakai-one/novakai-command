import {
  b3err, b3fail, b3ok,
  type B3Result, type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  ComposedAgentRuns, RecoverableCapability, RuntimeCensus,
} from '../../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import { readAllTerminalSessions } from './terminal-paging.js';

/** Terminal seen through Runtime's recovery/census seam. */
export function terminalRecovery(terminal: () => TerminalContract): RecoverableCapability {
  return {
    name: 'terminal',
    reconcile: (context, epochId) =>
      terminal().system.reconcileAfterRestart(context, { activeRuntimeEpochId: epochId }),
    async census(): Promise<B3Result<RuntimeCensus>> {
      const listed = await readAllTerminalSessions(
        terminal(), { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
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
      epochId,
      terminalSessionId,
    ) {
      const stopped = await terminal().terminateTerminal(context, {
        terminalSessionId,
        expectedRuntimeEpochId: epochId,
        reason: 'stop-one',
      });
      return stopped.ok ? b3ok(null) : stopped;
    },
  };
}

/** Agent Runtime seen through the same recovery/census seam. */
export function agentRunsRecovery(runs: () => ComposedAgentRuns): RecoverableCapability {
  return {
    name: 'agent-runs',
    async reconcile() {
      const reconciled = await runs().reconcileAfterRestart();
      return reconciled.ok ? b3ok({ reconciledSessionIds: [] }) : reconciled;
    },
    async census() {
      const counted = await runs().census();
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
      return b3fail(b3err(
        'UnsupportedOperation', 'agent-runs owns no terminal sessions to stop',
        { operation: 'runtime.stopSession', reason: 'not-a-session-owner' }, false,
      ));
    },
  };
}

// Where Agent Runtime and Supervision meet, and the only place they do.
//
// Same rule as `run-ports.ts` and `b3c-ports.ts`: neither capability imports
// the other's private code and neither writes the other's store. Agent Runtime
// asks one question through a narrow port; Supervision answers it through its
// FROZEN contract, and this file is the translation between the two.
import {
  b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type ResolvedLaunchPlanId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { AgentRunsContract, RunWatcherPort } from '../../../agent-runtime/contract/index.js';
import type { SupervisionCore } from '../../../supervision/core/index.js';
import type { VersionedRef } from '../../../supervision/contract/index.js';

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

const streamReader: AuthenticatedPrincipal = {
  id: 'sys_supervision', kind: 'system', verifiedScopes: [],
};

/**
 * §13.5's watcher rung, seen through the Runtime's own narrow seam.
 *
 * The Runtime hands over exactly what its immutable launch plan pinned and
 * gets back the identities that were installed. It cannot name a condition,
 * a recipient or a deadline, because inventing supervision policy is not a
 * Runtime fact (§3.3).
 */
export function supervisionWatcherPort(supervision: SupervisionCore): RunWatcherPort {
  return {
    async installRunWatchers(input) {
      const installed = await supervision.installRunWatchers(runtimeContext(), {
        agentRunId: input.agentRunId as AgentRunId,
        launchPlanId: input.launchPlanId as ResolvedLaunchPlanId,
        requiredTemplateRefs: input.requiredTemplateRefs as readonly VersionedRef[],
      });
      if (!installed.ok) return installed;
      return b3ok(installed.value.map((rule) => ({ id: String(rule.id) })));
    },
  };
}

export interface FollowedEvents {
  stop(): void;
}

/**
 * Supervision's whole clock: the ONE committed event stream the Runtime
 * already publishes (§15, §24.4).
 *
 * Deliberately a CONSUMER of the public stream rather than a hook inside the
 * commit path. A watcher that could delay a commit would be a watcher that can
 * take the Runtime down with it, and a watcher with its own timer would be the
 * polling this slice exists to retire.
 */
export function followEventsIntoSupervision(
  runs: AgentRunsContract, supervision: SupervisionCore,
): FollowedEvents {
  let stopped = false;
  void (async () => {
    for await (const frame of runs.subscribeRunEvents(streamReader, undefined)) {
      if (stopped) break;
      if (!frame.ok) continue;
      // A reducer failure is not a reason to stop watching. It is reported by
      // the record it failed to write, and the next event tries again.
      await supervision.evaluateEvent(runtimeContext(), { event: frame.value });
    }
  })();
  // Stopping is a flag, never a join. The published stream has no end of its
  // own, so waiting for the loop to finish would be waiting for ever — and a
  // shutdown that hangs on its own watcher is worse than one that stops
  // watching a moment early.
  return { stop: () => { stopped = true; } };
}

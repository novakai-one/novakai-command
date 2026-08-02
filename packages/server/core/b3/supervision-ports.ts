// Where Agent Runtime and Supervision meet, and the only place they do.
//
// Same rule as `run-ports.ts` and `b3c-ports.ts`: neither capability imports
// the other's private code and neither writes the other's store. Agent Runtime
// asks one question through a narrow port; Supervision answers it through its
// FROZEN contract, and this file is the translation between the two.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type ResolvedLaunchPlanId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { AgentRunsContract, RunWatcherPort } from '../../../agent-runtime/contract/index.js';
import type { GovernedAgentsContract } from '../../../agents/b3/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type {
  NotificationRecipient, VersionedRef, WatcherInstallAuthority, WatchRuleAccess,
} from '../../../supervision/contract/index.js';

const runtimeContext = (
  provenance?: { readonly clientOpId: SystemCommandContext<'sys_agent_runtime'>['clientOpId']; readonly traceId: SystemCommandContext<'sys_agent_runtime'>['traceId'] },
): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: provenance?.clientOpId ?? mintClientOpId(),
  traceId: provenance?.traceId ?? mintTraceCorrelationId(),
  contractVersion: 1,
});

const streamReader: AuthenticatedPrincipal = {
  id: 'sys_supervision', kind: 'system', verifiedScopes: [],
};

/** Agents + Runtime truth Supervision re-reads before accepting install facts. */
export function watcherInstallAuthority(
  agents: GovernedAgentsContract,
  runs: () => AgentRunsContract | undefined,
): WatcherInstallAuthority {
  return {
    async resolve(principal, input) {
      const runtime = runs();
      if (runtime === undefined) {
        return b3fail(b3err('RuntimeUnavailable', 'Agent Runtime is not composed', {}, true));
      }
      const [plan, runView] = await Promise.all([
        agents.getResolvedLaunchPlan(principal, input.launchPlanId),
        runtime.getAgentRun(principal, input.agentRunId),
      ]);
      if (!plan.ok) return plan;
      if (!runView.ok) return runView;
      if (runView.value.run.launchPlanId !== plan.value.id) {
        return b3fail(b3err(
          'IdempotencyConflict', 'Run is not pinned to the supplied launch plan', {}, false,
        ));
      }
      const parentRunId = runView.value.run.parentRequestingRunId;
      let recipient: NotificationRecipient;
      if (parentRunId !== undefined) {
        const parent = await runtime.getAgentRun(principal, parentRunId);
        if (!parent.ok) return parent;
        recipient = { kind: 'agent', agentId: parent.value.agent.agentId };
      } else {
        const agent = await agents.getAgent(principal, runView.value.agent.agentId);
        if (!agent.ok) return agent;
        recipient = { kind: 'human', principalId: agent.value.rootHumanPrincipalId as never };
      }
      return b3ok({
        agentRunId: runView.value.run.id,
        launchPlanId: plan.value.id,
        activityDrift: plan.value.supervisionPolicy.activityDrift,
        requiredTemplateRefs: plan.value.supervisionPolicy.requiredWatcherTemplates,
        parentNotificationMode: plan.value.supervisionPolicy.parentNotificationMode,
        recipient,
        activityGeneration: runView.value.run.activityGeneration,
      });
    },
  };
}

/** Stable Agent identity behind an authenticated Run, for watcher visibility. */
export function watchRuleAccess(
  runs: () => AgentRunsContract | undefined,
): WatchRuleAccess {
  return {
    async agentIdFor(principal) {
      if (principal.kind !== 'agent-run') return b3ok(null);
      if (principal.agentRunId === undefined) {
        return b3fail(b3err('PermissionDenied', 'agent-run principal has no Run identity', {}, false));
      }
      const runtime = runs();
      if (runtime === undefined) {
        return b3fail(b3err('RuntimeUnavailable', 'Agent Runtime is not composed', {}, true));
      }
      const runView = await runtime.getAgentRun(principal, principal.agentRunId);
      return runView.ok ? b3ok(runView.value.agent.agentId) : runView;
    },
  };
}

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
      const recipient: NotificationRecipient = input.recipient.kind === 'agent'
        ? { kind: 'agent', agentId: input.recipient.agentId }
        : { kind: 'human', principalId: input.recipient.principalId as never };
      const installed = await supervision.installRunWatchers(runtimeContext(input.requestProvenance), {
        agentRunId: input.agentRunId as AgentRunId,
        launchPlanId: input.launchPlanId as ResolvedLaunchPlanId,
        requiredTemplateRefs: input.requiredTemplateRefs as readonly VersionedRef[],
        recipient,
        activityGeneration: input.activityGeneration,
        requestProvenance: input.requestProvenance,
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

import {
  b3err, b3fail, b3ok,
  type AgentId, type AgentRunId, type AuthenticatedPrincipal, type B3Result,
  type ProviderSessionId,
} from '@novakai/foundation/contract';
import type { RunUsageFacts } from '../contract/runs-api.js';
import type { ProviderTurnSubmission } from '../contract/provider-turns.js';
import { FINAL_LIFECYCLES, type AgentRun } from '../contract/runs.js';
import { requireRun, type RunsCore } from './runs-context.js';

export function usageFacts(
  agentRun: AgentRun,
  submissions: readonly ProviderTurnSubmission[] = [],
): RunUsageFacts | null {
  if (agentRun.providerSessionId === undefined) return null;
  return {
    agentRunId: agentRun.id,
    agentId: agentRun.agentId,
    providerSessionId: agentRun.providerSessionId,
    lifecycle: agentRun.lifecycle,
    final: FINAL_LIFECYCLES.has(agentRun.lifecycle),
    activityGeneration: agentRun.activityGeneration,
    recordVersion: agentRun.recordVersion,
    ...(submissions.length === 0 ? {} : {
      providerTurnSubmissions: submissions.map((submission) => ({
        providerTurnId: submission.providerTurnId,
        state: submission.state.kind,
      })),
    }),
  };
}

async function usageSubmissions(
  core: RunsCore,
  agentRunId: AgentRunId,
): Promise<B3Result<readonly ProviderTurnSubmission[]>> {
  return core.store.list('providerTurnSubmission', { agentRunId });
}

/** Composition-only Runtime read that avoids Runtime→Supervision→Runtime recursion. */
export async function getUsageRun(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentRunId: AgentRunId,
): Promise<B3Result<RunUsageFacts>> {
  const agentRun = await requireRun(core, agentRunId);
  if (!agentRun.ok) return agentRun;
  const visible = await core.agents.getAgent(principal, agentRun.value.agentId);
  if (!visible.ok) return visible;
  const submissions = await usageSubmissions(core, agentRun.value.id);
  if (!submissions.ok) return submissions;
  const facts = usageFacts(agentRun.value, submissions.value);
  return facts === null
    ? b3fail(b3err('RuntimeUnavailable',
        'usage waits for transcript ingestion to assign a ProviderSession', {
          agentRunId,
          reason: 'provider-session-not-yet-ingested',
        }, true))
    : b3ok(facts);
}

/** All Runtime-owned Run facts for one visible stable Agent. */
export async function listUsageRuns(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentId: AgentId,
): Promise<B3Result<readonly RunUsageFacts[]>> {
  const visible = await core.agents.getAgent(principal, agentId);
  if (!visible.ok) return visible;
  const storedRuns = await core.store.list<AgentRun>('agentRun', { agentId });
  if (!storedRuns.ok) return storedRuns;
  const facts: RunUsageFacts[] = [];
  for (const agentRun of storedRuns.value) {
    const submissions = await usageSubmissions(core, agentRun.id);
    if (!submissions.ok) return submissions;
    const projected = usageFacts(agentRun, submissions.value);
    if (projected !== null) facts.push(projected);
  }
  return b3ok(facts);
}

/** Complete ProviderSession→Run correlation across live and final history. */
export async function resolveUsageRunByProviderSession(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  providerSessionId: ProviderSessionId,
): Promise<B3Result<RunUsageFacts | null>> {
  const stored = await core.store.list<AgentRun>('agentRun', { providerSessionId });
  if (!stored.ok) return stored;
  if (stored.value.length > 1) {
    return b3fail(b3err(
      'ProviderSessionReservationConflict',
      'one ProviderSession is bound to more than one Run',
      {
        providerSessionId,
        conflictingAgentRunIds: stored.value.map((agentRun) => agentRun.id).sort(),
      },
      false,
    ));
  }
  const agentRun = stored.value[0];
  if (agentRun === undefined) return b3ok(null);
  const visible = await core.agents.getAgent(principal, agentRun.agentId);
  return visible.ok ? b3ok(usageFacts(agentRun)) : visible;
}

/** The sole non-final Run for one Agent, or authoritative absence. */
export async function resolveCurrentRunByAgent(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentId: AgentId,
): Promise<B3Result<RunUsageFacts | null>> {
  const visible = await core.agents.getAgent(principal, agentId);
  if (!visible.ok) return visible;
  const stored = await core.store.list<AgentRun>('agentRun', { agentId });
  if (!stored.ok) return stored;
  const liveRuns = stored.value.filter(
    (agentRun) => !FINAL_LIFECYCLES.has(agentRun.lifecycle),
  );
  if (liveRuns.length > 1) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'current-Run uniqueness is not proven for this Agent',
      { agentId, conflictingAgentRunIds: liveRuns.map((agentRun) => agentRun.id).sort() },
      true,
    ));
  }
  return b3ok(liveRuns[0] === undefined ? null : usageFacts(liveRuns[0]));
}

// Controls on a LIVE Run (§12.1, R3-006, R3-025).
//
// Agents owns what a control means — which values a role permits, whether the
// provider supports it natively, and what a replacement would have to look
// like. The Runtime owns the Run. So the join lives here, and it exists for one
// reason: a caller should be able to say "set that Agent's model" with the two
// facts it actually has — which Run, and which version of it it read.
//
// Everything else (the Agent, the pinned plan, the provider session) is looked
// up from the Run rather than accepted from the request, because a caller that
// can name the plan can name SOMEONE ELSE'S plan (red gate 5).
import {
  b3err, b3fail,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type RecordVersion,
} from '@novakai/foundation/contract';
import type {
  AgentControlFacts, AgentControlOutcomeFacts, ControlCapabilityFacts,
} from '../contract/ports.js';
import type { ApplyRunControlInput, DiscoverRunControlsInput } from '../contract/runs-api.js';
import { requireRun, type RunsCore } from './runs-context.js';
import { runFinal } from './runs-store.js';
import { FINAL_LIFECYCLES } from '../contract/runs.js';

/** What the provider can actually do to this Run, right now. */
export async function discoverRunControls(
  core: RunsCore, principal: AuthenticatedPrincipal, input: DiscoverRunControlsInput,
): Promise<B3Result<ControlCapabilityFacts>> {
  const agentRun = await requireRun(core, input.agentRunId);
  if (!agentRun.ok) return agentRun;
  const authorised = await core.agents.authoriseRunOperation(principal, {
    targetAgentId: agentRun.value.agentId, operation: 'control',
  });
  if (!authorised.ok) return authorised;
  return core.agents.discoverAgentControls(principal, {
    agentRunId: agentRun.value.id,
    launchPlanId: agentRun.value.launchPlanId,
    ...(authorised.value.grantId === undefined ? {} : { delegationGrantId: authorised.value.grantId }),
  });
}

/**
 * Apply one control. Three answers are possible and all three are honest:
 * applied natively, unsupported with a reason, or "this needs a replacement
 * Run" — which returns the plan rather than silently restarting anything. A
 * control that quietly became a restart would lose whatever the Agent was
 * doing, so §12.1 makes the caller ask for it separately.
 */
export async function applyRunControl(
  core: RunsCore, context: CommandContext, input: ApplyRunControlInput,
): Promise<B3Result<AgentControlOutcomeFacts>> {
  const agentRun = await requireRun(core, input.agentRunId);
  if (!agentRun.ok) return agentRun;

  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: agentRun.value.agentId, operation: 'control',
  });
  if (!authorised.ok) return authorised;

  if (FINAL_LIFECYCLES.has(agentRun.value.lifecycle)) {
    return b3fail(runFinal(agentRun.value.id, agentRun.value.lifecycle));
  }

  // Compare-and-set on what the caller READ. Without it, two people changing
  // the model at once both succeed and the last write silently wins.
  if (agentRun.value.recordVersion !== input.expectedRunVersion) {
    return b3fail(b3err('VersionConflict',
      'that agent run changed while you were deciding',
      {
        objectId: agentRun.value.id,
        expected: input.expectedRunVersion,
        actual: agentRun.value.recordVersion,
      }, true));
  }
  if (agentRun.value.providerSessionId === undefined) {
    return b3fail(b3err('RuntimeUnavailable',
      'headless transcript-first Runs do not expose terminal provider controls', {
        agentRunId: agentRun.value.id,
        reason: 'provider-session-not-yet-ingested',
      }, false));
  }

  return core.agents.applyAgentControl(context, {
    agentRunId: agentRun.value.id,
    agentId: agentRun.value.agentId,
    launchPlanId: agentRun.value.launchPlanId,
    providerSessionId: agentRun.value.providerSessionId,
    expectedRunVersion: agentRun.value.recordVersion as RecordVersion,
    control: input.control as AgentControlFacts,
    ...(authorised.value.grantId === undefined ? {} : { delegationGrantId: authorised.value.grantId }),
  });
}

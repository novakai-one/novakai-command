// What happens to an Agent's children when its Run goes final.
//
// Split out of `lifecycle.ts` because it is not a lifecycle step. Interrupt,
// stop and stop-tree are all about ONE Run; this is about the supervision tree
// the Run leaves behind, and it is the only part of stopping that reads another
// Agent's role to decide.
import {
  b3ok, type AgentId, type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import {
  assignSupervisor, currentAssignment, liveRunOf, type RunsCore,
} from './runs-context.js';

/**
 * Children do NOT die with their parent unless the role says so. The default
 * is adopt-and-continue, and the nearest LIVE ancestor is preferred over the
 * root human, so a working subtree keeps a supervisor who knows about it.
 */
export async function applyOrphanPolicy(
  core: RunsCore, context: CommandContext, parentAgentId: AgentId,
): Promise<B3Result<null>> {
  const children = await core.agents.listChildRelationships(context.principal, parentAgentId);
  if (!children.ok) return children;
  for (const { childAgentId } of children.value) {
    const reassigned = await reassignOrphan(core, context, parentAgentId, childAgentId);
    if (!reassigned.ok) return reassigned;
  }
  return b3ok(null);
}

/** One child: its own role decides, and a child with no live Run is left alone. */
async function reassignOrphan(
  core: RunsCore, context: CommandContext, parentAgentId: AgentId, childAgentId: AgentId,
): Promise<B3Result<null>> {
  const live = await liveRunOf(core, childAgentId);
  if (!live.ok) return live;
  if (live.value === null) return b3ok(null);
  const plan = await core.agents.getLaunchPlan(context.principal, live.value.launchPlanId);
  if (!plan.ok) return plan;
  const previous = await currentAssignment(core, childAgentId);
  if (!previous.ok) return previous;
  const supervisor = await nextSupervisor(
    core, context, parentAgentId, plan.value.lifecyclePolicy.onSupervisorFinal,
  );
  if (!supervisor.ok) return supervisor;
  const assigned = await assignSupervisor(core, context, {
    subjectAgentId: childAgentId,
    supervisor: supervisor.value,
    reason: 'parent-final-policy',
    ...(previous.value === null ? {} : { previousAssignmentId: previous.value.id }),
  });
  if (!assigned.ok) return assigned;
  return b3ok(null);
}

async function nextSupervisor(
  core: RunsCore,
  context: CommandContext,
  formerParentAgentId: AgentId,
  policy: 'assign-human' | 'assign-nearest-live-ancestor' | 'remain-orphaned',
): Promise<B3Result<Parameters<typeof assignSupervisor>[2]['supervisor']>> {
  if (policy === 'remain-orphaned') {
    return b3ok({ kind: 'orphaned', reason: 'the role asked to remain orphaned' });
  }
  const parent = await core.agents.getAgent(context.principal, formerParentAgentId);
  if (!parent.ok) return parent;
  if (policy === 'assign-human') {
    return b3ok({ kind: 'human', principalId: parent.value.rootHumanPrincipalId });
  }
  const assignment = await currentAssignment(core, formerParentAgentId);
  if (!assignment.ok) return assignment;
  // The nearest live ancestor is whoever was supervising the parent. When that
  // is another Agent with no live Run, Chris is the honest answer.
  const inherited = assignment.value?.supervisor;
  if (inherited?.kind === 'agent') {
    const live = await liveRunOf(core, inherited.agentId);
    if (!live.ok) return live;
    if (live.value !== null) return b3ok(inherited);
  }
  return b3ok({ kind: 'human', principalId: parent.value.rootHumanPrincipalId });
}

// Adoption: moving who supervises an Agent.
//
// Who supervises an Agent can change. Who SPAWNED it never can. Everything in
// this file writes `SupervisionAssignment` and nothing in it can reach an
// `AgentRelationship` — the separation is structural, not a promise.
import {
  b3err, b3fail, b3ok,
  type AgentId, type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { AdoptAgentInput } from '../contract/runs-api.js';
import type { SupervisionAssignment } from '../contract/runs.js';
import {
  assignSupervisor, assignmentChain, liveRunOf, type RunsCore,
} from './runs-context.js';
import { descendantsOf, insideClosingTree, treeClosing } from './stop-tree.js';

export async function adoptAgent(
  core: RunsCore, context: CommandContext, input: AdoptAgentInput,
): Promise<B3Result<SupervisionAssignment>> {
  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: input.subjectAgentId, operation: 'adopt',
  });
  if (!authorised.ok) return authorised;

  const subject = await core.agents.getAgent(context.principal, input.subjectAgentId);
  if (!subject.ok) return subject;

  const fenced = await insideClosingTree(core, context, input.subjectAgentId);
  if (!fenced.ok) return fenced;
  if (fenced.value !== null) {
    return b3fail(treeClosing(fenced.value.rootAgentId, fenced.value.id));
  }

  const eligible = await checkSupervisor(core, context, input);
  if (!eligible.ok) return eligible;

  // Compare-and-set against the supervision GENERATION the caller read. Two
  // concurrent adoptions cannot both win.
  const chain = await assignmentChain(core, input.subjectAgentId);
  if (!chain.ok) return chain;
  if (chain.value.generation !== input.expectedAssignmentVersion) {
    return b3fail(b3err('VersionConflict',
      'this Agent was reassigned while you were deciding',
      {
        objectId: chain.value.current?.id ?? input.subjectAgentId,
        expected: input.expectedAssignmentVersion,
        actual: chain.value.generation,
      }, true));
  }

  return assignSupervisor(core, context, {
    subjectAgentId: input.subjectAgentId,
    supervisor: input.supervisor,
    reason: 'explicit-adoption',
    ...(chain.value.current === null ? {} : { previousAssignmentId: chain.value.current.id }),
  });
}

/**
 * The candidate must be live, eligible, outside a closing tree, and
 * unable to create a cycle. A supervisor inside the subtree it supervises is a
 * cycle even though the FAMILY tree is untouched — supervision has its own
 * acyclicity to keep.
 */
async function checkSupervisor(
  core: RunsCore, context: CommandContext, input: AdoptAgentInput,
): Promise<B3Result<null>> {
  if (input.supervisor.kind === 'human') return b3ok(null);
  const candidate = input.supervisor.agentId;
  if (candidate === input.subjectAgentId) {
    return b3fail(ineligible(candidate, 'an Agent cannot supervise itself'));
  }
  const agent = await core.agents.getAgent(context.principal, candidate);
  if (!agent.ok) return agent;
  if (agent.value.status !== 'active') {
    return b3fail(ineligible(candidate, 'the candidate supervisor is archived'));
  }
  const live = await liveRunOf(core, candidate);
  if (!live.ok) return live;
  if (live.value === null) {
    return b3fail(ineligible(candidate, 'the candidate supervisor has no live run'));
  }
  const fenced = await insideClosingTree(core, context, candidate);
  if (!fenced.ok) return fenced;
  if (fenced.value !== null) {
    return b3fail(ineligible(candidate, 'the candidate supervisor is inside a closing tree'));
  }
  const below = await descendantsOf(core, context, input.subjectAgentId);
  if (!below.ok) return below;
  if (below.value.includes(candidate)) {
    return b3fail(ineligible(candidate,
      'the candidate is a descendant of the Agent it would supervise'));
  }
  return noCycle(core, input.subjectAgentId, candidate);
}

/**
 * Supervision has its own acyclicity, independent of the family tree.
 *
 * Two Agents on unrelated trees may each lawfully be put under the other — one
 * at a time. Doing both closes a loop in which each supervises the other and
 * the chain never reaches a human, so nobody is accountable for either. The
 * family-descendant check cannot see this, because no family edge is involved.
 */
async function noCycle(
  core: RunsCore, subjectAgentId: AgentId, candidate: AgentId,
): Promise<B3Result<null>> {
  const seen = new Set<AgentId>([subjectAgentId]);
  let walking: AgentId | null = candidate;
  while (walking !== null) {
    if (seen.has(walking)) {
      return b3fail(b3err('RelationshipCycle',
        'that supervisor is already supervised by the Agent it would take on',
        { subjectAgentId, candidate, throughAgentId: walking }, false));
    }
    seen.add(walking);
    const chain: Awaited<ReturnType<typeof assignmentChain>> =
      await assignmentChain(core, walking);
    if (!chain.ok) return chain;
    const above = chain.value.current?.supervisor;
    walking = above !== undefined && above.kind === 'agent' ? above.agentId : null;
  }
  return b3ok(null);
}

const ineligible = (candidate: AgentId, reason: string): ReturnType<typeof b3err> =>
  b3err('SupervisorIneligible', reason, { candidate, reason }, false);

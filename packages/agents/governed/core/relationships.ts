// The family tree.
//
// Three properties, and all three are load-bearing:
//   - append-only: an edge, once recorded, is history and never moves;
//   - acyclic: a descendant can never become its own ancestor;
//   - deterministic: recording the same parent→child twice is idempotent, not
//     a second edge, so a saga retry does not deform the tree.
//
// Adoption lives elsewhere on purpose. Who supervises an Agent today is a
// different question from who spawned it, and the two never mix here.
import {
  b3err, b3fail, b3ok, mintAgentRelationshipId, nowIsoUtc,
  type AgentId, type AuthenticatedPrincipal, type B3Page, type B3Result,
  type CommandContext,
} from '@novakai/foundation/contract';
import type { AgentTreeNode, GetAgentTreeInput, RecordRelationshipInput } from '../contract/api.js';
import { readRecordRelationshipInput } from '../contract/validate.js';
import type { Agent, AgentRelationship } from '../contract/records.js';
import type { GovernedAgentsCore } from './context.js';
import type { Persisted } from './store.js';

export async function recordRelationship(
  core: GovernedAgentsCore, context: CommandContext, input: RecordRelationshipInput,
): Promise<B3Result<AgentRelationship>> {
  const read = readRecordRelationshipInput(input);
  if (!read.ok) return read;
  const request = read.value;

  if (request.parentAgentId === request.childAgentId) {
    return b3fail(relationshipCycle(request.parentAgentId, request.childAgentId));
  }

  const id = mintAgentRelationshipId(request.parentAgentId, request.childAgentId);
  const existing = await core.store.read<AgentRelationship>('agentRelationship', id);
  if (!existing.ok) return existing;
  // The same edge asked for twice is the same edge — the deterministic id
  // makes a retry idempotent rather than a duplicate.
  if (existing.value !== null) return b3ok(existing.value);

  // A child may not already be an ancestor of its new parent. Checked against
  // the durable tree, not the caller's belief about it.
  const ancestors = await ancestorIdsOf(core, request.parentAgentId);
  if (!ancestors.ok) return ancestors;
  if (ancestors.value.includes(request.childAgentId)) {
    return b3fail(relationshipCycle(request.parentAgentId, request.childAgentId));
  }

  const record: Persisted<AgentRelationship> = {
    kind: 'agentRelationship',
    id,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    rootHumanPrincipalId: request.rootHumanPrincipalId,
    parentAgentId: request.parentAgentId,
    childAgentId: request.childAgentId,
    createdFromRunId: request.createdFromRunId,
  };
  return core.store.create<AgentRelationship>(
    context.principal.id, record as never, context.clientOpId,
  );
}

/** Every edge, once. Small enough to hold; the tree is a team, not a dataset. */
async function allEdges(
  core: GovernedAgentsCore,
): Promise<B3Result<readonly AgentRelationship[]>> {
  return core.store.list<AgentRelationship>('agentRelationship');
}

export async function ancestorIdsOf(
  core: GovernedAgentsCore, agentId: AgentId,
): Promise<B3Result<readonly AgentId[]>> {
  const edges = await allEdges(core);
  if (!edges.ok) return edges;
  const parentOf = new Map<AgentId, AgentId>();
  for (const edge of edges.value) parentOf.set(edge.childAgentId, edge.parentAgentId);

  const found: AgentId[] = [];
  const seen = new Set<AgentId>([agentId]);
  let current = parentOf.get(agentId);
  // `seen` also terminates a cycle that somehow reached the store, so a corrupt
  // tree degrades to a wrong answer rather than a hang.
  while (current !== undefined && !seen.has(current)) {
    found.push(current);
    seen.add(current);
    current = parentOf.get(current);
  }
  return b3ok(found);
}

export async function descendantIdsOf(
  core: GovernedAgentsCore, agentId: AgentId,
): Promise<B3Result<readonly AgentId[]>> {
  const edges = await allEdges(core);
  if (!edges.ok) return edges;
  return b3ok(descendantsFrom(edges.value, agentId));
}

/** Parent → children, built once and shared by every downward walk (DRY). */
function childrenIndex(
  edges: readonly AgentRelationship[],
): Map<AgentId, AgentId[]> {
  const childrenOf = new Map<AgentId, AgentId[]>();
  for (const edge of edges) {
    const held = childrenOf.get(edge.parentAgentId) ?? [];
    held.push(edge.childAgentId);
    childrenOf.set(edge.parentAgentId, held);
  }
  return childrenOf;
}

/** Breadth-first, so "bottom-up" stop order can be derived by reversing depth. */
function descendantsFrom(
  edges: readonly AgentRelationship[], rootAgentId: AgentId,
): readonly AgentId[] {
  const childrenOf = childrenIndex(edges);
  const found: AgentId[] = [];
  const seen = new Set<AgentId>([rootAgentId]);
  let frontier = childrenOf.get(rootAgentId) ?? [];
  while (frontier.length > 0) {
    const next: AgentId[] = [];
    for (const child of frontier) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      next.push(...(childrenOf.get(child) ?? []));
    }
    frontier = next;
  }
  return found;
}

export async function listChildren(
  core: GovernedAgentsCore,
  _principal: AuthenticatedPrincipal,
  parentAgentId: AgentId,
): Promise<B3Result<readonly AgentRelationship[]>> {
  return core.store.list<AgentRelationship>('agentRelationship', { parentAgentId });
}

/**
 * The tree as Chris reads it: every Agent, its edge, and how far from the root
 * it sits. Ancestors come back at negative-free depth counted upward, so
 * "direction: both" is one list rather than two shapes to reconcile.
 */
export async function getAgentTree(
  core: GovernedAgentsCore, _principal: AuthenticatedPrincipal, input: GetAgentTreeInput,
): Promise<B3Result<B3Page<AgentTreeNode>>> {
  const edges = await allEdges(core);
  if (!edges.ok) return edges;
  const agents = await core.store.list<Agent>('agent');
  if (!agents.ok) return agents;
  const agentById = new Map<AgentId, Agent>(agents.value.map((agent) => [agent.id, agent]));
  const edgeByChild = new Map<AgentId, AgentRelationship>(
    edges.value.map((edge) => [edge.childAgentId, edge]),
  );

  const wanted = new Map<AgentId, number>([[input.rootAgentId, 0]]);
  if (input.direction !== 'ancestors') {
    collectDown(edges.value, input.rootAgentId, input.maxDepth, wanted);
  }
  if (input.direction !== 'descendants') {
    collectUp(edgeByChild, input.rootAgentId, input.maxDepth, wanted);
  }

  return b3ok(assemble(wanted, agentById, edgeByChild));
}

/**
 * An edge naming an Agent this reader cannot see is omitted and COUNTED, never
 * silently dropped — a tree that quietly loses a branch is worse than one that
 * says a branch is missing.
 */
function assemble(
  wanted: Map<AgentId, number>,
  agentById: Map<AgentId, Agent>,
  edgeByChild: Map<AgentId, AgentRelationship>,
): B3Page<AgentTreeNode> {
  const items: AgentTreeNode[] = [];
  let omitted = 0;
  for (const [agentId, depth] of wanted) {
    const agent = agentById.get(agentId);
    if (agent === undefined) {
      omitted += 1;
      continue;
    }
    const relationship = edgeByChild.get(agentId);
    items.push({ agent, depth, ...(relationship ? { relationship } : {}) });
  }
  items.sort((left, right) => left.depth - right.depth
    || left.agent.id.localeCompare(right.agent.id));
  return {
    items,
    omissions: omitted === 0 ? [] : [{ reason: 'permission', count: omitted }],
  };
}

function collectDown(
  edges: readonly AgentRelationship[],
  rootAgentId: AgentId,
  maxDepth: number,
  into: Map<AgentId, number>,
): void {
  const childrenOf = childrenIndex(edges);
  let frontier: AgentId[] = [rootAgentId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    frontier = nextGeneration(childrenOf, frontier, depth, into);
  }
}

/** One generation down, recording depth for everyone not already placed. */
function nextGeneration(
  childrenOf: Map<AgentId, AgentId[]>,
  frontier: readonly AgentId[],
  depth: number,
  into: Map<AgentId, number>,
): AgentId[] {
  const next: AgentId[] = [];
  for (const parent of frontier) {
    for (const child of childrenOf.get(parent) ?? []) {
      if (into.has(child)) continue;
      into.set(child, depth);
      next.push(child);
    }
  }
  return next;
}

function collectUp(
  edgeByChild: Map<AgentId, AgentRelationship>,
  rootAgentId: AgentId,
  maxDepth: number,
  into: Map<AgentId, number>,
): void {
  let current = edgeByChild.get(rootAgentId)?.parentAgentId;
  for (let depth = 1; depth <= maxDepth && current !== undefined; depth += 1) {
    if (into.has(current)) break;
    into.set(current, depth);
    current = edgeByChild.get(current)?.parentAgentId;
  }
}

export const relationshipCycle = (
  parentAgentId: string, childAgentId: string,
): ReturnType<typeof b3err> => b3err('RelationshipCycle',
  'recording this edge would make an Agent its own ancestor',
  { parentAgentId, childAgentId }, false);

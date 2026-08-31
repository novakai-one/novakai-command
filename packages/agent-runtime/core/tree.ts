// The published family tree, walked in the direction the caller asked
// for and carrying the two facts only the tree knows: edges and depth.
//
// This lives beside `queries.ts` rather than inside it because the tree is a
// walk over ANOTHER capability's truth — Agents owns parentage — while the rest
// of `queries` reads Runs the Runtime itself wrote.
import {
  b3ok, nowIsoUtc,
  type AgentId, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentRunTreeNode, AgentRunTreeView, GetAgentRunTreeInput,
} from '../contract/runs-api.js';
import type { AgentRelationshipFacts } from '../contract/ports.js';
import type { RunsCore } from './runs-context.js';
import { runsOfAgent } from './queries.js';

/**
 * The family, walked the way the caller ASKED for it.
 *
 * `direction` used to be accepted and dropped, so "show me this Agent's
 * ancestors" answered with its descendants — the same three nodes, which reads
 * as a working feature until you check the names. Descendants walk down through
 * Agents' child edges; ancestors walk up through immutable parentage; `both`
 * is one list, because reconciling two shapes is the caller's problem the tree
 * exists to remove.
 */
export async function getAgentRunTree(
  core: RunsCore, principal: AuthenticatedPrincipal, input: GetAgentRunTreeInput,
): Promise<B3Result<AgentRunTreeView>> {
  const direction = input.direction ?? 'descendants';
  const walk: TreeWalk = {
    nodes: [], edges: new Map(), seen: new Set(),
  };
  const root = await collectAgent(core, principal, walk, input.rootAgentId, 0);
  if (!root.ok) return root;

  if (direction !== 'ancestors') {
    const downward = await walkDescendants(core, principal, walk, input);
    if (!downward.ok) return downward;
  }
  if (direction !== 'descendants') {
    const upward = await walkAncestors(core, principal, walk, input);
    if (!upward.ok) return upward;
  }
  return b3ok({
    rootAgentId: input.rootAgentId,
    nodes: walk.nodes,
    edges: [...walk.edges.values()],
    generatedAt: nowIsoUtc(),
  });
}

interface TreeWalk {
  readonly nodes: AgentRunTreeNode[];
  /** Keyed by edge id, so `both` cannot report one relationship twice. */
  readonly edges: Map<string, AgentRelationshipFacts>;
  readonly seen: Set<AgentId>;
}

/** Generation by generation, down through the children Agents recorded. */
async function walkDescendants(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  walk: TreeWalk,
  input: GetAgentRunTreeInput,
): Promise<B3Result<null>> {
  let frontier: readonly AgentId[] = [input.rootAgentId];
  for (let depth = 1; depth <= input.maxDepth && frontier.length > 0; depth += 1) {
    const generation = await oneGeneration(core, principal, walk, frontier, depth);
    if (!generation.ok) return generation;
    frontier = generation.value;
  }
  return b3ok(null);
}

/** Every child of this frontier, collected, plus who to visit next. */
async function oneGeneration(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  walk: TreeWalk,
  frontier: readonly AgentId[],
  depth: number,
): Promise<B3Result<readonly AgentId[]>> {
  const edges = await childEdgesOf(core, principal, frontier);
  if (!edges.ok) return edges;
  const next: AgentId[] = [];
  for (const edge of edges.value) {
    walk.edges.set(edge.id, edge);
    const collected = await collectAgent(core, principal, walk, edge.childAgentId, depth);
    if (!collected.ok) return collected;
    if (collected.value) next.push(edge.childAgentId);
  }
  return b3ok(next);
}

async function childEdgesOf(
  core: RunsCore, principal: AuthenticatedPrincipal, parents: readonly AgentId[],
): Promise<B3Result<readonly AgentRelationshipFacts[]>> {
  const found: AgentRelationshipFacts[] = [];
  for (const parentAgentId of parents) {
    const children = await core.agents.listChildRelationships(principal, parentAgentId);
    if (!children.ok) return children;
    found.push(...children.value);
  }
  return b3ok(found);
}

/** Straight up the immutable parent chain — one parent per generation. */
async function walkAncestors(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  walk: TreeWalk,
  input: GetAgentRunTreeInput,
): Promise<B3Result<null>> {
  let child: AgentId = input.rootAgentId;
  for (let depth = 1; depth <= input.maxDepth; depth += 1) {
    const climbed = await oneAncestor(core, principal, walk, child, depth);
    if (!climbed.ok) return climbed;
    if (climbed.value === null) break;
    child = climbed.value;
  }
  return b3ok(null);
}

/** The parent of one Agent, collected — or null when the climb is over. */
async function oneAncestor(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  walk: TreeWalk,
  child: AgentId,
  depth: number,
): Promise<B3Result<AgentId | null>> {
  const parent = await core.agents.parentAgentIdOf(principal, child);
  if (!parent.ok) return parent;
  if (parent.value === null) return b3ok(null);
  const edges = await core.agents.listChildRelationships(principal, parent.value);
  if (!edges.ok) return edges;
  for (const edge of edges.value) {
    if (edge.childAgentId === child) walk.edges.set(edge.id, edge);
  }
  const collected = await collectAgent(core, principal, walk, parent.value, depth);
  if (!collected.ok) return collected;
  return b3ok(collected.value ? parent.value : null);
}

/** Every Run of one Agent, at a known distance from the root. False if seen. */
async function collectAgent(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  walk: TreeWalk,
  agentId: AgentId,
  depth: number,
): Promise<B3Result<boolean>> {
  if (walk.seen.has(agentId)) return b3ok(false);
  walk.seen.add(agentId);
  const collected = await runsOfAgent(core, principal, agentId);
  if (!collected.ok) return collected;
  for (const view of collected.value) {
    walk.nodes.push({ ...view, depth, currentSupervision: view.family.supervisor });
  }
  return b3ok(true);
}

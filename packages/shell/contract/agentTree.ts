// shell/contract/agentTree.ts — the Shell's read of an Agent family
// (FZ-VIEW-007, P2 §12.7:2652–2657), served by `getAgentRunTree`.
//
// A browser-safe COPY, under the same two rules as the other two doors: field
// names verbatim, upstream unions as `string`. A tree node IS an
// `AgentRunRowView` plus the two facts only the tree knows — how far from the
// queried root it sits, and who is supervising it right now — so this file
// EXTENDS the Runs projection rather than restating it. One copy of a contract
// is a liability; two would be a defect.
//
// Two honesty problems are specific to a tree, and both are answered here
// rather than on the screen:
//
//   1. DEPTH IS THE OWNER'S. `node.depth` is a published field. The CLI's
//      `describeTree` re-derives it by walking `family.parentAgentId` in array
//      order — which gives a child that arrives before its parent the wrong
//      generation, and makes Shell and CLI able to draw two different families
//      from one fixture (FZ-VIEW-034). Reported as L-13; this side reads the
//      field.
//   2. A DEPTH-LIMITED TREE IS NOT A COMPLETE FAMILY. `getAgentRunTree` takes
//      `maxDepth`, and the answer carries no marker saying it was cut — the
//      AMD-005 named residual ("tree truncation marker"). A node whose
//      `childCount` exceeds the children actually present, and an edge pointing
//      at an Agent that is not in the node set, are both first-hand evidence
//      that the family continues past the edge of this answer. Said out loud,
//      because "no children shown" reading as "no children" is the tree-shaped
//      version of the false empty.
import type { AgentRunRowView, RunSupervisorView } from './agentRuns.js';

/** `AgentRunTreeNode`, verbatim: a Run view plus the tree's own two facts. */
export interface AgentRunTreeNodeView extends AgentRunRowView {
  readonly depth: number;
  readonly currentSupervision: RunSupervisorView;
}

/** `AgentRelationshipFacts`, verbatim — every parent→child edge in the set. */
export interface AgentRelationshipEdgeView {
  readonly id: string;
  readonly kind: string;
  readonly rootHumanPrincipalId: string;
  readonly parentAgentId: string;
  readonly childAgentId: string;
  readonly createdFromRunId: string;
}

export interface AgentRunTreeView {
  readonly rootAgentId: string;
  readonly nodes: readonly AgentRunTreeNodeView[];
  readonly edges: readonly AgentRelationshipEdgeView[];
  readonly generatedAt: string;
}

export interface GetAgentRunTreeRequest {
  readonly rootAgentId: string;
  readonly maxDepth?: number;
}

/**
 * Who looks after this Run right now, from the field the TREE publishes.
 *
 * Deliberately not `family.supervisor`: the tree repeats supervision at node
 * level on purpose (the Runtime's own comment says so), and a consumer that
 * reached past the node-level fact into `family` would be reading a second
 * copy — the drift the field exists to prevent.
 */
export function describeNodeSupervision(node: AgentRunTreeNodeView): string {
  const supervisor = node.currentSupervision;
  if (supervisor.kind === 'human') return `supervised by ${supervisor.principalId}`;
  if (supervisor.kind === 'agent') return `supervised by ${supervisor.agentId}`;
  return `orphaned · ${supervisor.reason}`;
}

const idOf = (supervisor: RunSupervisorView): string =>
  (supervisor.kind === 'human' ? supervisor.principalId
    : supervisor.kind === 'agent' ? supervisor.agentId
      : supervisor.reason);

/**
 * The tree and the Run row can disagree about who is supervising, and when they
 * do the reader is entitled to know rather than to be handed whichever one this
 * screen happened to prefer. Neither is corrected here — a consumer picking a
 * winner between two owner-published facts is exactly the invention CL-S bans.
 */
export function supervisionDisagreement(node: AgentRunTreeNodeView): string {
  const family = node.family.supervisor;
  const tree = node.currentSupervision;
  if (family.kind === tree.kind && idOf(family) === idOf(tree)) return '';
  return `the tree says ${describeNodeSupervision(node)}, the Run row says `
    + `${family.kind === 'orphaned' ? `orphaned · ${family.reason}` : `supervised by ${idOf(family)}`}`;
}

/** How many of a node's children are actually IN this answer. */
function childrenPresent(view: AgentRunTreeView, agentId: string): number {
  const inTree = new Set(view.nodes.map((node) => node.agent.agentId));
  return view.edges
    .filter((edge) => edge.parentAgentId === agentId && inTree.has(edge.childAgentId))
    .length;
}

/**
 * What this answer cannot show, said in the answer's own numbers.
 *
 * AMD-005 left "tree truncation marker" as a named residual: `maxDepth` cuts
 * the family and nothing in the returned view says it was cut. These two checks
 * are the evidence that IS in the view — the owner's own `childCount` beside
 * the children present, and edges naming Agents outside the node set — so the
 * Shell can decline to present a slice as a whole family without inventing a
 * marker the contract does not carry.
 */
export function treeCompleteness(view: AgentRunTreeView): readonly string[] {
  const said: string[] = [];
  for (const node of view.nodes) {
    const present = childrenPresent(view, node.agent.agentId);
    if (node.family.childCount > present) {
      said.push(`${node.agent.displayName}: ${node.family.childCount} child agent(s), `
        + `${present} in this tree`);
    }
  }
  const inTree = new Set(view.nodes.map((node) => node.agent.agentId));
  const outside = view.edges.filter((edge) =>
    !inTree.has(edge.childAgentId) || !inTree.has(edge.parentAgentId)).length;
  if (outside > 0) {
    said.push(`${outside} relationship(s) name an Agent that is not in this tree`);
  }
  return said;
}

/** `2026-08-06T09:12:00.000Z` → `2026-08-06 09:12 UTC`; unparseable passes through. */
export function describeGeneratedAt(view: AgentRunTreeView): string {
  const when = new Date(view.generatedAt);
  if (Number.isNaN(when.getTime())) return `read at ${view.generatedAt}`;
  return `read at ${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 16)} UTC`;
}

/**
 * Indentation, from the owner's `depth` and from nothing else — see note 1 at
 * the top of this file. Bounded so a malformed depth cannot push a row off the
 * screen; the number itself is still drawn, so a clamp is visible rather than
 * silent.
 */
export const MAX_DRAWN_DEPTH = 8;

export function indentFor(node: AgentRunTreeNodeView): number {
  return Math.max(0, Math.min(MAX_DRAWN_DEPTH, node.depth));
}

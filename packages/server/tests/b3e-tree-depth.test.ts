// L-13: the CLI re-derived a fact the projection already publishes.
//
// `AgentRunTreeNode.depth` is the owner's answer to "which generation is this"
// (§12.7). `describeTree` ignored it and recomputed each node's generation by
// walking `family.parentAgentId` IN ARRAY ORDER — `depthOf.get(parent) ?? 0` —
// so a child that arrives before its parent is printed one generation too
// shallow, and the CLI and the Shell draw two different families from ONE
// answer. That is the FZ-VIEW-034 failure shape exactly.
//
// Nothing about the response is malformed when this happens: node order is not
// promised to be parents-first, and `?? 0` turns "I have not seen that parent"
// into "it is the root" without saying so. This is a pure function over a
// published projection, so it is tested as one — the ordering that breaks it is
// hard to arrange against a live Runtime and trivial to state here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTree } from '../cli/agent-describe.js';
import type { AgentRunTreeView } from '../../agent-runtime/contract/index.js';

const AGENTS = {
  root: 'agent_00000000-0000-7000-8000-00000000r000',
  child: 'agent_00000000-0000-7000-8000-00000000c000',
  grandchild: 'agent_00000000-0000-7000-8000-00000000g000',
} as const;

/** One node, with only the members `describeTree` reads. */
function node(
  agentId: string, displayName: string, depth: number, parentAgentId?: string,
): unknown {
  return {
    depth,
    agent: { agentId, displayName },
    provider: { provider: 'claude' },
    run: { id: `agentRun_${agentId.slice(-12)}`, lifecycle: 'running' },
    family: parentAgentId === undefined ? {} : { parentAgentId },
  };
}

/**
 * The tree, with the grandchild BEFORE its parent. Every `depth` is the owner's
 * own, and the array order is the thing the old walk depended on.
 */
const OUT_OF_ORDER = {
  rootAgentId: AGENTS.root,
  nodes: [
    node(AGENTS.root, 'Root', 0),
    node(AGENTS.grandchild, 'Grandchild', 2, AGENTS.child),
    node(AGENTS.child, 'Child', 1, AGENTS.root),
  ],
  edges: [],
  generatedAt: '2026-08-06T10:00:00.000Z',
} as unknown as AgentRunTreeView;

const indentOf = (line: string): number => (/^ */u.exec(line)?.[0].length ?? 0) / 2;

test('L-13: a node is drawn at the depth the owner published, whatever the order', () => {
  const lines = describeTree(OUT_OF_ORDER).split('\n');
  const at = (name: string): number =>
    indentOf(lines.find((line) => line.includes(name)) ?? '');

  assert.equal(at('Root'), 0);
  assert.equal(at('Child'), 1);
  // The one that used to be wrong: its parent had not been seen yet, so
  // `depthOf.get(parent) ?? 0` made it a first-generation child of the root.
  assert.equal(at('Grandchild'), 2,
    `the grandchild was drawn at generation ${String(at('Grandchild'))}: ${lines.join(' | ')}`);
});

test('L-13: the same tree in parents-first order draws identically', () => {
  // The two orders are ONE family. If the drawing depends on the order, these
  // differ — which is the whole defect, stated as an equality.
  const parentsFirst = {
    ...OUT_OF_ORDER,
    nodes: [OUT_OF_ORDER.nodes[0], OUT_OF_ORDER.nodes[2], OUT_OF_ORDER.nodes[1]],
  } as AgentRunTreeView;
  const sorted = (view: AgentRunTreeView): string =>
    describeTree(view).split('\n').sort().join('\n');
  assert.equal(sorted(OUT_OF_ORDER), sorted(parentsFirst));
});

test('L-13: an empty tree still says so', () => {
  const empty = { ...OUT_OF_ORDER, nodes: [] } as unknown as AgentRunTreeView;
  assert.equal(describeTree(empty), 'No agents under that root.');
});

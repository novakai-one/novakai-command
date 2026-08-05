// tools/tree-preview.tsx — a dev-only VISUAL proof of the Agent family
// (FZ-VIEW-007). The REAL `TreeView` over literal nodes; no fake services, no
// socket, no second composition (the tracer's law). The offline harness has no
// Runtime, so the real screen reaches its honest no-door state and stops.
//
// Four generations, and every one of the tree's own honesty cases in one
// picture: a family cut by maxDepth, a relationship pointing outside the
// answer, and one node where the tree and the Run row disagree about who is
// supervising.
//
// Not in the shipped bundle: `vite build` builds `index.html`.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TreeView } from '../ui/screens/agents/TreeScreen.js';
import { runRow } from '../tests/fixtures/agentRunRow.js';
import type { AgentRunTreeNodeView } from '../contract/agentTree.js';

const node = (
  over: Parameters<typeof runRow>[0] & {
    depth: number;
    currentSupervision?: AgentRunTreeNodeView['currentSupervision'];
  },
): AgentRunTreeNodeView => ({
  ...runRow(over),
  depth: over.depth,
  currentSupervision: over.currentSupervision
    ?? { kind: 'human', principalId: 'person_chris' },
});

const edge = (parent: string, child: string) => ({
  id: `agentRelationship_${parent}_${child}`,
  kind: 'agentRelationship',
  rootHumanPrincipalId: 'person_chris',
  parentAgentId: parent,
  childAgentId: child,
  createdFromRunId: 'agentRun_root',
});

const tree = {
  rootAgentId: 'agent_root',
  generatedAt: '2026-08-06T10:00:00.000Z',
  nodes: [
    node({
      agentId: 'agent_root', id: 'agentRun_root', name: 'Orchestrator',
      depth: 0, childCount: 2, activity: 'working', lifecycle: 'running',
    }),
    node({
      agentId: 'agent_lane_a', id: 'agentRun_lane_a', name: 'Lane A',
      depth: 1, parentAgentId: 'agent_root', childCount: 1,
      lifecycle: 'running', activity: 'working',
      // Both sides of the supervision fact agree here, as they normally do —
      // the first draft of this page set only the tree side and three rows
      // came out marked, which is the "a mark on every row" pattern the whole
      // screen is built to avoid. The browser caught it; the fixture was wrong.
      currentSupervision: { kind: 'agent', agentId: 'agent_root' },
      supervisor: { kind: 'agent', agentId: 'agent_root' },
    }),
    node({
      agentId: 'agent_seat_1', id: 'agentRun_seat_1', name: 'Lane A · seat 1',
      depth: 2, parentAgentId: 'agent_lane_a',
      lifecycle: 'completed', activity: 'idle',
      // The disagreement: the tree says the orchestrator has it now, the Run
      // row still names Chris. Neither is corrected; both are stated.
      currentSupervision: { kind: 'agent', agentId: 'agent_root' },
      supervisor: { kind: 'human', principalId: 'person_chris' },
    }),
    node({
      agentId: 'agent_lane_b', id: 'agentRun_lane_b', name: 'Lane B',
      depth: 1, parentAgentId: 'agent_root',
      // Three children the answer does not contain — the family continues past
      // the edge of this read, and the view says so rather than implying a
      // leaf.
      childCount: 3, lifecycle: 'running', activity: 'unknown',
      currentSupervision: { kind: 'agent', agentId: 'agent_root' },
      supervisor: { kind: 'agent', agentId: 'agent_root' },
    }),
  ],
  edges: [
    edge('agent_root', 'agent_lane_a'),
    edge('agent_root', 'agent_lane_b'),
    edge('agent_lane_a', 'agent_seat_1'),
    // A relationship naming an Agent nobody sent a node for.
    edge('agent_lane_b', 'agent_seat_4'),
  ],
};

createRoot(document.getElementById('preview')!)
  .render(<TreeView tree={tree} error={null} />);

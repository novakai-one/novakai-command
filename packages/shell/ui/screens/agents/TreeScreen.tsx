// shell/ui/screens/agents/TreeScreen.tsx — the Agent family (FZ-VIEW-007).
// Kit-composed only (red gate 3).
//
// The tree answers ONE question — who is under whom, and who is looking after
// them — and leaves everything else about a Run to the Runs screen. Depth is
// drawn as indentation because indentation IS the fact; a "depth: 2" label
// would be the shell telling Chris what a shape already says.
//
// What it refuses: to re-derive depth (the owner publishes it), to pick a
// winner when the tree and the Run row disagree about supervision, and to let a
// depth-limited answer read as a whole family.
//
// The indent is a CSS rule per `data-depth`, not an inline style: `indentFor`
// clamps the depth to a bounded set (MAX_DRAWN_DEPTH), so the set of legal
// indents is finite and belongs in the stylesheet with everything else.
import React, { useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import { describeRunState } from '../../../contract/agentRuns.js';
import {
  describeGeneratedAt, describeNodeSupervision, indentFor, supervisionDisagreement,
  treeCompleteness, type AgentRunTreeNodeView, type AgentRunTreeView,
} from '../../../contract/agentTree.js';
import { answerFrom, type AnswerFailure } from '../../../contract/listAnswer.js';
import {
  EmptyState, InlineError, ListRow, Panel, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './tree.css';

/** Pure presentational — every value arrives as a prop, nothing is derived. */
export function TreeView(props: {
  tree: AgentRunTreeView | null;
  error: AnswerFailure | null;
}) {
  const answer = answerFrom({
    source: props.tree,
    failure: props.error,
    rowsOf: (tree: AgentRunTreeView) => tree.nodes,
  });
  const gaps = props.tree === null ? [] : treeCompleteness(props.tree);

  return (
    <ScrollArea className="nv-tree__scroll">
      <Panel head="Agent family">
        <Stack className="nv-tree">
          {props.tree !== null && (
            <Text as="p" className="nv-tree__root">
              {`Under ${props.tree.rootAgentId} · ${describeGeneratedAt(props.tree)}`}
            </Text>
          )}
          {answer.kind === 'failed' && (
            <InlineError>{`${answer.failure.code}: ${answer.failure.message}`}</InlineError>
          )}
          {answer.kind === 'waiting' && <EmptyState>Reading the family…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No Agents under that root</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-tree__rows">
              {answer.rows.map((node) => <TreeRow key={node.run.id} node={node} />)}
            </Stack>
          )}
          {/* What this answer cannot show, in its own numbers. Quiet, and
              always last — a family that continues past the edge of the page
              must not read as a family that ends there. */}
          {gaps.map((unshown) => (
            <Text as="p" key={unshown} className="nv-tree__gap">{unshown}</Text>
          ))}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

function TreeRow(props: { node: AgentRunTreeNodeView }) {
  const node = props.node;
  const disagreement = supervisionDisagreement(node);

  return (
    <Stack
      gap={0}
      className="nv-tree__row"
      data-depth={indentFor(node)}
      data-disagreement={disagreement === '' ? 'false' : 'true'}
    >
      <ListRow label={node.agent.displayName} meta={describeRunState(node)} />
      <Text as="p" className="nv-tree__meta">
        {`${describeNodeSupervision(node)} · ${node.run.id}`}
      </Text>
      {disagreement !== '' && (
        <Text as="p" className="nv-tree__disagreement">{disagreement}</Text>
      )}
    </Stack>
  );
}

/**
 * The connected screen. The root is the Agent this host knows first — a tree
 * needs a root, and the screen says which one it asked about rather than
 * implying it drew every Agent there is.
 */
export function TreeScreen(props: { services: ShellServices }) {
  const [tree, setTree] = useState<AgentRunTreeView | null>(null);
  const [error, setError] = useState<AnswerFailure | null>(null);
  const door = props.services.agentRuns;
  const roster = props.services.agents;

  useEffect(() => {
    let live = true;
    if (door === undefined) {
      setError({
        code: 'RuntimeUnavailable',
        message: 'this host has no Novakai Runtime to read the family from',
      });
      return () => { live = false; };
    }
    void (async () => {
      const agents = roster === undefined ? [] : await roster.listAgents();
      if (!live) return;
      const root = agents[0]?.id;
      if (root === undefined) {
        setError({
          code: 'NoSubject',
          message: 'this host knows no Agents, so there is no family to draw',
        });
        return;
      }
      const result = await door.runs.getAgentRunTree({ rootAgentId: root });
      if (!live) return;
      if (result.ok) {
        setTree(result.value);
        setError(null);
        return;
      }
      setTree(null);
      setError(result.error);
    })();
    return () => { live = false; };
  }, [door, roster]);

  return <TreeView tree={tree} error={error} />;
}

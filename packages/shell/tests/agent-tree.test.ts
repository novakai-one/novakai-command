// B3e LANE-B B2.4 — the Agent family (FZ-VIEW-007), and the two ways a tree
// lies that a flat list cannot.
//
//   1. DEPTH. `AgentRunTreeNode.depth` is published by the owner. The CLI
//      re-derives it by walking `family.parentAgentId` in array order, so a
//      child that arrives before its parent gets the wrong generation — two
//      surfaces, one fixture, two different families (FZ-VIEW-034). The Shell
//      reads the field. The first block below is that difference, pinned.
//   2. TRUNCATION. `maxDepth` cuts the family and the answer carries no marker
//      saying so (the AMD-005 named residual). "No children shown" reading as
//      "no children" is the false empty in tree form, so the evidence that IS
//      in the view — childCount beside the children present, and edges naming
//      Agents outside the node set — is drawn.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MAX_DRAWN_DEPTH, describeGeneratedAt, describeNodeSupervision, indentFor,
  supervisionDisagreement, treeCompleteness,
  type AgentRunTreeNodeView, type AgentRunTreeView,
} from '../contract/agentTree.js';
import { TreeView } from '../ui/screens/agents/TreeScreen.js';
import { runRow, type RunRowOverrides } from './fixtures/agentRunRow.js';

function node(
  partial: RunRowOverrides & {
    depth?: number;
    currentSupervision?: AgentRunTreeNodeView['currentSupervision'];
  } = {},
): AgentRunTreeNodeView {
  return {
    ...runRow(partial),
    depth: partial.depth ?? 0,
    currentSupervision: partial.currentSupervision
      ?? { kind: 'human', principalId: 'person_chris' },
  };
}

const edge = (parent: string, child: string) => ({
  id: `agentRelationship_${parent}_${child}`,
  kind: 'agentRelationship',
  rootHumanPrincipalId: 'person_chris',
  parentAgentId: parent,
  childAgentId: child,
  createdFromRunId: 'agentRun_1',
});

function tree(partial: Partial<AgentRunTreeView> = {}): AgentRunTreeView {
  return {
    rootAgentId: 'agent_root',
    nodes: [node({ agentId: 'agent_root', id: 'agentRun_root', name: 'Root' })],
    edges: [],
    generatedAt: '2026-08-06T10:00:00.000Z',
    ...partial,
  };
}

const htmlFor = (view: AgentRunTreeView | null = tree(), error = null): string =>
  renderToStaticMarkup(React.createElement(TreeView, { tree: view, error }));

describe('depth is the owner\'s fact (FZ-VIEW-034, L-13)', () => {
  it('indents from node.depth, not from walking the parent chain', () => {
    // The child arrives FIRST. The CLI's derivation gives it depth 1 by
    // accident of array order; the published field says 2, and the Shell draws
    // 2. If this ever passes by drawing 1, the Shell and the CLI are drawing
    // two different families from one answer.
    const grandchild = node({
      agentId: 'agent_c', id: 'agentRun_c', name: 'Grandchild',
      parentAgentId: 'agent_b', depth: 2,
    });
    const child = node({
      agentId: 'agent_b', id: 'agentRun_b', name: 'Child',
      parentAgentId: 'agent_root', depth: 1,
    });
    expect(indentFor(grandchild)).toBe(2);
    const html = htmlFor(tree({
      nodes: [grandchild, child, node({ agentId: 'agent_root', id: 'agentRun_root', name: 'Root' })],
      edges: [edge('agent_root', 'agent_b'), edge('agent_b', 'agent_c')],
    }));
    expect(html).toContain('data-depth="2"');
    expect(html).toContain('data-depth="1"');
  });

  it('does not let a later rule reset the indent it just set', () => {
    // Found in a screenshot: the exception rule used the `padding` shorthand,
    // which resets padding-left, so the ONE row that disagreed drew at the left
    // margin and read as a root. The DOM was right the whole time — only the
    // picture was wrong, which is why this assertion is on the stylesheet.
    const css = readFileSync(
      fileURLToPath(new URL('../ui/screens/agents/tree.css', import.meta.url)), 'utf8',
    );
    const rules = css.split('}').filter((rule) => rule.includes('.nv-tree__row['));
    for (const rule of rules) {
      if (!rule.includes('data-depth')) {
        expect(rule, 'a row rule after the depth rules may not use the padding shorthand')
          .not.toMatch(/^\s*padding:/mu);
      }
    }
    // And the depth rules themselves still exist, one per legal generation.
    for (let depth = 1; depth <= MAX_DRAWN_DEPTH; depth += 1) {
      expect(css).toContain(`[data-depth='${depth}']`);
    }
  });

  it('keeps a nonsense depth on screen while refusing to indent off it', () => {
    expect(indentFor(node({ depth: 400 }))).toBe(MAX_DRAWN_DEPTH);
    expect(indentFor(node({ depth: -3 }))).toBe(0);
  });

  it('renders the nodes in the order the owner sent them', () => {
    const html = htmlFor(tree({
      nodes: [
        node({ agentId: 'agent_root', id: 'agentRun_root', name: 'Root' }),
        node({ agentId: 'agent_b', id: 'agentRun_b', name: 'Child', depth: 1 }),
      ],
    }));
    expect(html.indexOf('Root')).toBeLessThan(html.indexOf('Child'));
  });
});

describe('a depth-limited answer is not a whole family (AMD-005 residual)', () => {
  it('says how many children are missing, in the owner\'s own numbers', () => {
    const said = treeCompleteness(tree({
      nodes: [node({
        agentId: 'agent_root', id: 'agentRun_root', name: 'Root', childCount: 3,
      })],
    }));
    expect(said.join(' ')).toContain('3 child agent(s), 0 in this tree');
  });

  it('counts a child that IS present, and then says nothing', () => {
    const said = treeCompleteness(tree({
      nodes: [
        node({ agentId: 'agent_root', id: 'agentRun_root', name: 'Root', childCount: 1 }),
        node({ agentId: 'agent_b', id: 'agentRun_b', name: 'Child', depth: 1 }),
      ],
      edges: [edge('agent_root', 'agent_b')],
    }));
    expect(said).toEqual([]);
  });

  it('reports an edge that points outside the answer', () => {
    const said = treeCompleteness(tree({
      nodes: [node({ agentId: 'agent_root', id: 'agentRun_root', name: 'Root', childCount: 1 })],
      edges: [edge('agent_root', 'agent_gone')],
    }));
    expect(said.join(' ')).toContain('1 relationship(s) name an Agent that is not in this tree');
  });

  it('draws the gap on screen, never only in a return value', () => {
    const html = htmlFor(tree({
      nodes: [node({
        agentId: 'agent_root', id: 'agentRun_root', name: 'Root', childCount: 4,
      })],
    }));
    expect(html).toContain('4 child agent(s), 0 in this tree');
    // And it does NOT say the family ends here.
    expect(html).not.toMatch(/no children/iu);
  });
});

describe('supervision: the tree\'s own field, and the disagreement', () => {
  it('reads currentSupervision rather than digging into family', () => {
    expect(describeNodeSupervision(node({
      currentSupervision: { kind: 'agent', agentId: 'agent_super' },
    }))).toContain('agent_super');
    expect(describeNodeSupervision(node({
      currentSupervision: { kind: 'orphaned', reason: 'supervisor Run ended' },
    }))).toContain('orphaned');
  });

  it('states a disagreement instead of picking a winner', () => {
    const split = node({
      supervisor: { kind: 'human', principalId: 'person_chris' },
      currentSupervision: { kind: 'agent', agentId: 'agent_super' },
    });
    const said = supervisionDisagreement(split);
    expect(said).toContain('agent_super');
    expect(said).toContain('person_chris');
    const html = htmlFor(tree({ nodes: [split] }));
    expect(html).toContain('data-disagreement="true"');
    // A family where the two agree carries no mark at all — one exception, or
    // none, never a badge on every row.
    expect(htmlFor()).toContain('data-disagreement="false"');
  });

  it('says nothing when the two agree', () => {
    expect(supervisionDisagreement(node())).toBe('');
  });
});

describe('the four states of an answer, again (B2.1)', () => {
  it('does not say the family is empty before anyone has answered', () => {
    const html = htmlFor(null);
    expect(html).toContain('Reading the family');
    expect(html).not.toMatch(/No Agents under that root/u);
  });

  it('says so when the owner answered none', () => {
    expect(htmlFor(tree({ nodes: [] }))).toMatch(/No Agents under that root/u);
  });

  it('draws a failure as a failure', () => {
    const html = renderToStaticMarkup(React.createElement(TreeView, {
      tree: null,
      error: { code: 'RuntimeUnavailable', message: 'no Runtime on this host' },
    }));
    expect(html).toContain('RuntimeUnavailable');
    expect(html).not.toMatch(/No Agents under that root/u);
  });

  it('names the root it asked about and when the answer was read', () => {
    const html = htmlFor();
    expect(html).toContain('agent_root');
    expect(describeGeneratedAt(tree())).toBe('read at 2026-08-06 10:00 UTC');
    expect(describeGeneratedAt(tree({ generatedAt: 'not-a-date' }))).toContain('not-a-date');
  });
});

// The published tree, read the way §12.7 publishes it (hold-out D8, D9).
//
// A blind consumer asked `b3.agent.getTree` three questions and got one answer:
// `direction` was accepted and ignored (asking for a root's ANCESTORS returned
// its descendants), the view carried no `edges`, and no node carried `depth` or
// `currentSupervision`. All three are named in §12.7 — `edges` on
// `AgentRunTreeView`, `direction`/`depth`/`currentSupervision` on the family
// tree — and a second host has exactly one tree door to read them through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import {
  createLaunchAuthorities, type LaunchAuthorityRegistrar,
} from '../../../terminal/adapters/pty-host/node-pty.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';
import { chatRole } from '../governed-role.js';

interface RunView {
  agent: { agentId: string; displayName: string };
  run: { id: string; recordVersion: number };
}

interface TreeNode extends RunView {
  depth: number;
  currentSupervision?: { kind: string };
}

interface TreeView {
  rootAgentId: string;
  nodes: readonly TreeNode[];
  edges: readonly {
    parentAgentId: string; childAgentId: string; createdFromRunId: string;
  }[];
  generatedAt: string;
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly authorities: LaunchAuthorityRegistrar;
  role(name: string, children?: readonly string[]): Promise<string>;
  asRun(): Promise<RuntimeClient>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-tree-'));
  const ptyHost = createFakePtyHost();
  const authorities = createLaunchAuthorities();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, authorities, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  const opened: RuntimeClient[] = [];
  return {
    host, chris, ptyHost, authorities,
    async role(name, children = []) {
      const made = await chris.call<{ id: string }>(
        'b3.agent.createRole', chatRole(name, children), mintClientOpId(),
      );
      if (!made.ok) throw new Error(`createRole: ${made.error.message}`);
      return made.value.id;
    },
    async asRun() {
      const spec = ptyHost.started[ptyHost.started.length - 1]!.spec;
      const environment = authorities.lookup(spec.launchAuthorityRef)?.environment ?? {};
      const client = await connectRuntime({
        root: '', port: host.port, token: host.token,
        agentRunId: environment['NVK_AGENT_RUN_ID'] ?? '',
        runToken: environment['NVK_AGENT_RUN_TOKEN'] ?? '',
      });
      opened.push(client);
      return client;
    },
    async close() {
      for (const client of opened) await client.close();
      await chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function value<T>(result: { ok: boolean } & Record<string, unknown>, what: string): T {
  if (!result.ok) throw new Error(`${what}: ${JSON.stringify(result['error'])}`);
  return result['value'] as T;
}

/** Three live generations under one root, each spawned by the one above it. */
async function threeGenerations(rig: Rig): Promise<RunView> {
  const grandchildRole = await rig.role('tree-gc');
  const childRole = await rig.role('tree-c', [grandchildRole]);
  const rootRole = await rig.role('tree-root', [childRole]);

  const root = value<RunView>(await rig.chris.call('b3.agent.spawn', {
    roleProfileId: rootRole, displayName: 'T-Root', workingDirectory: tmpdir(),
  }, mintClientOpId()), 'spawn root');
  const asRoot = await rig.asRun();
  value<RunView>(await asRoot.call('b3.agent.spawn', {
    roleProfileId: childRole, displayName: 'T-Child', workingDirectory: tmpdir(),
  }, mintClientOpId()), 'spawn child');
  const asChild = await rig.asRun();
  value<RunView>(await asChild.call('b3.agent.spawn', {
    roleProfileId: grandchildRole, displayName: 'T-Grandchild', workingDirectory: tmpdir(),
  }, mintClientOpId()), 'spawn grandchild');
  return root;
}

test('getTree honours direction: a root has descendants and no ancestors', async () => {
  const rig = await createRig();
  try {
    const root = await threeGenerations(rig);

    const down = value<TreeView>(await rig.chris.call('b3.agent.getTree', {
      rootAgentId: root.agent.agentId, direction: 'descendants', maxDepth: 8,
    }, mintClientOpId()), 'getTree descendants');
    const downNames = down.nodes.map((node) => node.agent.displayName).sort();
    assert.deepEqual(downNames, ['T-Child', 'T-Grandchild', 'T-Root'],
      'descendants must be the whole family under the root');

    const up = value<TreeView>(await rig.chris.call('b3.agent.getTree', {
      rootAgentId: root.agent.agentId, direction: 'ancestors', maxDepth: 8,
    }, mintClientOpId()), 'getTree ancestors');
    assert.deepEqual(up.nodes.map((node) => node.agent.displayName), ['T-Root'],
      'a root asked for its ANCESTORS must not be handed its descendants');
  } finally {
    await rig.close();
  }
});

test('the tree view carries the edges, depth and supervision §12.7 publishes', async () => {
  const rig = await createRig();
  try {
    const root = await threeGenerations(rig);

    const view = value<TreeView>(await rig.chris.call('b3.agent.getTree', {
      rootAgentId: root.agent.agentId, direction: 'descendants', maxDepth: 8,
    }, mintClientOpId()), 'getTree');

    assert.equal(Array.isArray(view.edges), true, 'AgentRunTreeView.edges is normative');
    assert.equal(view.edges.length, 2, 'two parent→child edges across three generations');

    const byName = new Map(view.nodes.map((node) => [node.agent.displayName, node]));
    assert.equal(byName.get('T-Root')?.depth, 0);
    assert.equal(byName.get('T-Child')?.depth, 1);
    assert.equal(byName.get('T-Grandchild')?.depth, 2);
    assert.equal(byName.get('T-Child')?.currentSupervision?.kind, 'agent',
      'a spawned child is supervised by the Agent that spawned it');
  } finally {
    await rig.close();
  }
});

test('a family edge records the Run that actually created it', async () => {
  const rig = await createRig();
  try {
    const childRole = await rig.role('edge-child');
    const parentRole = await rig.role('edge-parent', [childRole]);
    const parent = value<RunView>(await rig.chris.call('b3.agent.spawn', {
      roleProfileId: parentRole, displayName: 'E-Parent', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn parent');
    const asParent = await rig.asRun();
    const child = value<RunView>(await asParent.call('b3.agent.spawn', {
      roleProfileId: childRole, displayName: 'E-Child', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn child');

    const view = value<TreeView>(await rig.chris.call('b3.agent.getTree', {
      rootAgentId: parent.agent.agentId, direction: 'descendants', maxDepth: 4,
    }, mintClientOpId()), 'getTree');
    const edge = view.edges.find((item) => item.childAgentId === child.agent.agentId);
    assert.notEqual(edge, undefined, 'the child has no family edge');
    // codex F9: this stored a freshly minted, unrelated AgentRunId — a durable
    // provenance field whose value referred to nothing that ever existed.
    assert.equal(edge?.createdFromRunId, parent.run.id,
      'the edge must name the Run that spawned the child');
  } finally {
    await rig.close();
  }
});

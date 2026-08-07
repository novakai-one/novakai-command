// Three contract surfaces that existed only inside the code (hold-out D10, E9, G6).
//
// Delegation grants were being WRITTEN on every spawn and read by nobody, so
// every §22 row that turns on a grant was untestable from outside. The
// tree-closing fence — named in B3b's own exit line — had no read at all. And
// `repairRunOperation`, which §12.2 publishes as THE recovery action for a
// stranded operation, was `unknown method` on the socket.
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
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';
import { chatRole, governedRole, governedTokens } from '../governed-role.js';

interface RunView {
  agent: { agentId: string; displayName: string };
  run: { id: string; recordVersion: number };
}

interface Grant {
  id: string;
  issuerAgentRunId: string;
  targetAgentIds: readonly string[];
  scopes: readonly string[];
  status: string;
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly authorities: LaunchAuthorityRegistrar;
  role(name: string, children?: readonly string[]): Promise<string>;
  spawn(client: RuntimeClient, roleId: string, name: string): Promise<RunView>;
  asRun(): Promise<RuntimeClient>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-recovery-'));
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
    async spawn(client, roleProfileId, displayName) {
      const spawned = await client.call<RunView>('b3.agent.spawn', {
        roleProfileId, displayName, workingDirectory: tmpdir(),
      }, mintClientOpId());
      if (!spawned.ok) throw new Error(`spawn ${displayName}: ${spawned.error.message}`);
      return spawned.value;
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

test('a grant issued through the public door is what lets one Agent reach another', async () => {
  const rig = await createRig();
  try {
    const role = await rig.role('grant-public');
    const actor = await rig.spawn(rig.chris, role, 'Actor');
    const asActor = await rig.asRun();
    const stranger = await rig.spawn(rig.chris, role, 'Stranger');

    const before = await asActor.call('b3.agent.interrupt', {
      agentRunId: stranger.run.id, expectedRecordVersion: stranger.run.recordVersion,
    }, mintClientOpId());
    assert.equal(before.ok, false, 'an ungranted Agent reached a stranger');

    const issued = await rig.chris.call<Grant>('b3.agent.issueGrant', {
      issuerAgentRunId: actor.run.id,
      subjectAgentId: actor.agent.agentId,
      targetAgentIds: [stranger.agent.agentId],
      requestedScopes: ['agent.interrupt'],
      requestedChildRoleIds: [],
    }, mintClientOpId());
    assert.equal(issued.ok, true, issued.ok ? '' : `issueGrant: ${issued.error.message}`);
    if (!issued.ok) return;
    assert.deepEqual(issued.value.targetAgentIds, [stranger.agent.agentId]);

    const after = await asActor.call('b3.agent.interrupt', {
      agentRunId: stranger.run.id, expectedRecordVersion: stranger.run.recordVersion,
    }, mintClientOpId());
    assert.equal(after.ok, true,
      after.ok ? '' : `a granted Agent still could not reach its target: ${after.error.code}`);

    const listed = await rig.chris.call<readonly Grant[]>('b3.agent.listGrants', {
      holderAgentRunId: actor.run.id,
    }, mintClientOpId());
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error.message);
    if (!listed.ok) return;
    assert.equal(listed.value.some((grant) => grant.id === issued.value.id), true,
      'a grant that was issued is not readable');
  } finally {
    await rig.close();
  }
});

test('an Agent cannot hand its authority to a Run outside its own reach', async () => {
  const rig = await createRig();
  try {
    const role = await rig.role('grant-reach');
    await rig.spawn(rig.chris, role, 'Actor');
    const asActor = await rig.asRun();
    const stranger = await rig.spawn(rig.chris, role, 'Stranger');

    // The residue P0-4 reported: `issuerAgentRunId` names the Run the grant is
    // FOR, and it arrived from the payload. An Agent naming a stranger's Run
    // would be handing its own bounded authority to somebody it cannot reach.
    const forged = await asActor.call('b3.agent.issueGrant', {
      issuerAgentRunId: stranger.run.id,
      subjectAgentId: stranger.agent.agentId,
      targetAgentIds: [stranger.agent.agentId],
      requestedScopes: ['agent.interrupt'],
      requestedChildRoleIds: [],
    }, mintClientOpId());
    assert.equal(forged.ok, false, 'an Agent granted authority to a stranger Run');
    if (!forged.ok) {
      assert.equal(forged.error.code, 'PermissionDenied');
    }
  } finally {
    await rig.close();
  }
});

test('the tree-closing fence is readable, and a quiet family reports none', async () => {
  const rig = await createRig();
  try {
    const childRole = await rig.role('fence-child');
    const parentRole = await rig.role('fence-parent', [childRole]);
    const parent = await rig.spawn(rig.chris, parentRole, 'Parent');
    const asParent = await rig.asRun();
    await rig.spawn(asParent, childRole, 'Child');

    const quiet = await rig.chris.call<unknown>('b3.agent.getTreeFence', {
      agentId: parent.agent.agentId,
    }, mintClientOpId());
    assert.equal(quiet.ok, true, quiet.ok ? '' : `getTreeFence: ${quiet.error.message}`);
    if (quiet.ok) {
      assert.equal(quiet.value, null, 'a family nobody is stopping reported a fence');
    }
  } finally {
    await rig.close();
  }
});

test('a stranded operation has a public repair door', async () => {
  const rig = await createRig();
  try {
    const childRole = await rig.role('repair-child');
    const parentRole = await rig.role('repair-parent', [childRole]);
    const parent = await rig.spawn(rig.chris, parentRole, 'Parent');

    const prepared = await rig.chris.call<{ confirmationToken: string }>(
      'b3.agent.prepareStopTree', { rootAgentId: parent.agent.agentId }, mintClientOpId(),
    );
    assert.equal(prepared.ok, true, prepared.ok ? '' : prepared.error.message);
    if (!prepared.ok) return;
    const stopped = await rig.chris.call<{ operation: { id: string; state: string } }>(
      'b3.agent.stopTree', {
        rootAgentId: parent.agent.agentId,
        confirmationToken: prepared.value.confirmationToken,
        confirmation: 'stop-tree',
      }, mintClientOpId(),
    );
    assert.equal(stopped.ok, true, stopped.ok ? '' : stopped.error.message);
    if (!stopped.ok) return;

    const repaired = await rig.chris.call<{ operation: { state: string } }>(
      'b3.agent.repairOperation', { operationId: stopped.value.operation.id }, mintClientOpId(),
    );
    assert.equal(repaired.ok, true,
      repaired.ok ? '' : `repairOperation: ${repaired.error.code}`);
    if (repaired.ok) assert.equal(repaired.value.operation.state, 'completed');

    const unknown = await rig.chris.call('b3.agent.repairOperation', {
      operationId: 'runOperation_2222222222222222222222222222222222222222222222222222',
    }, mintClientOpId());
    assert.equal(unknown.ok, false, 'repairing an operation that does not exist answered ok');
  } finally {
    await rig.close();
  }
});

test('an outside caller can read the skills a Run is pinned to', async () => {
  const rig = await createRig();
  try {
    // §6.3's confirmation is the provider's own reply, read off the transcript
    // — the spec defines no method for submitting one, and inventing one would
    // let a caller confirm on an agent's behalf. What an external harness
    // genuinely lacked is the READ: no published way to see a Run's pinned
    // skills, so nobody outside could tell what a correct confirmation is.
    const role = await rig.chris.call<{ id: string }>(
      'b3.agent.createRole', governedRole('plan-read'), mintClientOpId(),
    );
    assert.equal(role.ok, true, role.ok ? '' : role.error.message);
    if (!role.ok) return;
    const run = await rig.spawn(rig.chris, role.value.id, 'Pinned');

    const plan = await rig.chris.call<{
      id: string;
      skills: readonly { id: string; version: number; digest: string }[];
      skillsConfirmationGate: { mode: string };
    }>('b3.agent.getLaunchPlan', { agentRunId: run.run.id }, mintClientOpId());
    assert.equal(plan.ok, true, plan.ok ? '' : `getLaunchPlan: ${plan.error.message}`);
    if (!plan.ok) return;
    assert.deepEqual(
      plan.value.skills.map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`).sort(),
      governedTokens(),
      'the published plan must name exactly the skills the gate will demand');
    assert.equal(plan.value.skillsConfirmationGate.mode, 'required-two-turn');
  } finally {
    await rig.close();
  }
});

// A parent actually holds authority over its own child (§5.3, §22, red gate 6).
//
// The probe found promise 4 passing for the wrong reason: every control on
// every target was denied identically, whether the target was a descendant, an
// ancestor or a stranger — because an Agent-Run principal held nothing but
// `agent.spawn`. The grant that would give a parent authority over the child it
// just created was written under the SAME clientOpId as the child's own grant,
// so the store returned the first as an idempotent replay and swallowed the
// second; and its result was never checked, so nothing noticed.
//
// A refusal only proves scoping when something in the same shape is ALLOWED.
// So this suite asserts both halves: the parent may reach its child, and may
// not reach a stranger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import {
  createLaunchAuthorities, type LaunchAuthorityRegistrar,
} from '../../terminal/adapters/pty-host/node-pty.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { chatRole } from './governed-role.js';

interface RunView {
  agent: { agentId: string };
  run: { id: string; recordVersion: number };
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly authorities: LaunchAuthorityRegistrar;
  role(name: string, children?: readonly string[]): Promise<string>;
  /** A client authenticated as the Run whose PTY was started last. */
  asRun(): Promise<RuntimeClient>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-grant-'));
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

test('a parent may interrupt and stop the child it spawned, and no one else', async () => {
  const rig = await createRig();
  try {
    const childRole = await rig.role('grant-child');
    const parentRole = await rig.role('grant-parent', [childRole]);

    const parent = value<RunView>(await rig.chris.call('b3.agent.spawn', {
      roleProfileId: parentRole, displayName: 'Parent', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn parent');
    const asParent = await rig.asRun();

    // The child is spawned BY the parent, over the parent's own credential —
    // which is the only way the parent-over-child grant can be issued at all.
    const child = value<RunView>(await asParent.call('b3.agent.spawn', {
      roleProfileId: childRole, displayName: 'Child', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn child');

    // A stranger: same shape, same role, but nothing to do with this parent.
    const stranger = value<RunView>(await rig.chris.call('b3.agent.spawn', {
      roleProfileId: childRole, displayName: 'Stranger', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn stranger');

    const reachesChild = await asParent.call('b3.agent.interrupt', {
      agentRunId: child.run.id,
      expectedRecordVersion: child.run.recordVersion,
    }, mintClientOpId());
    assert.equal(reachesChild.ok, true,
      reachesChild.ok
        ? ''
        : `a parent could not reach its own child: ${reachesChild.error.code}`);

    const reachesStranger = await asParent.call('b3.agent.interrupt', {
      agentRunId: stranger.run.id,
      expectedRecordVersion: stranger.run.recordVersion,
    }, mintClientOpId());
    assert.equal(reachesStranger.ok, false, 'a parent reached an unrelated Agent');
    if (!reachesStranger.ok) {
      assert.equal(reachesStranger.error.code, 'PermissionDenied');
    }

    const stopsChild = await asParent.call('b3.agent.stop', {
      agentId: child.agent.agentId,
      expectedLiveRunId: child.run.id,
      confirmation: 'stop-one',
    }, mintClientOpId());
    assert.equal(stopsChild.ok, true,
      stopsChild.ok ? '' : `a parent could not stop its own child: ${stopsChild.error.code}`);
  } finally {
    await rig.close();
  }
});

test('a parent may not reach its own ancestors', async () => {
  const rig = await createRig();
  try {
    const grandchildRole = await rig.role('grant-gc');
    const childRole = await rig.role('grant-c', [grandchildRole]);
    const rootRole = await rig.role('grant-root', [childRole]);

    const root = value<RunView>(await rig.chris.call('b3.agent.spawn', {
      roleProfileId: rootRole, displayName: 'Root', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn root');
    const asRoot = await rig.asRun();
    value<RunView>(await asRoot.call('b3.agent.spawn', {
      roleProfileId: childRole, displayName: 'Middle', workingDirectory: tmpdir(),
    }, mintClientOpId()), 'spawn middle');
    const asMiddle = await rig.asRun();

    // Authority runs downward. A child holding a grant over ITS children must
    // never be able to turn that on the parent that made it.
    const upward = await asMiddle.call('b3.agent.stop', {
      agentId: root.agent.agentId,
      expectedLiveRunId: root.run.id,
      confirmation: 'stop-one',
    }, mintClientOpId());
    assert.equal(upward.ok, false, 'a child stopped its own parent');
    if (!upward.ok) assert.equal(upward.error.code, 'PermissionDenied');
  } finally {
    await rig.close();
  }
});

// A continued Agent is still ITSELF (§13.6, DEC-B3V4-05, red gate 5).
//
// Spawn injects the Run credential into the managed PTY; continuation used to
// pass `runtimeEnvironment: {}`. Two things followed, and both are worse than
// they look:
//
//   1. a restarted Agent could no longer act as itself — it cannot spawn its own
//      children, so the three-generation story dies at the first restart;
//   2. it was PROMOTED. A caller with no credential is the local human, who
//      holds every scope Chris does. So a restarted agent that shells out to
//      `nvk agent` held Chris's full authority over the whole tree.
//
// The proof reads the environment the PTY was actually started with, because
// that is the only place the answer is not a claim.
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
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/runtime-host/client.js';
import { chatRole } from '../governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  readonly authorities: LaunchAuthorityRegistrar;
  roleId(name: string): Promise<string>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-identity-'));
  const ptyHost = createFakePtyHost();
  const authorities = createLaunchAuthorities();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, authorities, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost, authorities,
    async roleId(name) {
      const made = await chris.call<{ id: string }>(
        'b3.agent.createRole', chatRole(name), mintClientOpId(),
      );
      if (!made.ok) throw new Error(`createRole: ${made.error.message}`);
      return made.value.id;
    },
    async close() {
      await chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

interface RunView {
  agent: { agentId: string };
  run: { id: string; recordVersion: number };
}

/**
 * The environment the Runtime actually registered for the newest PTY.
 *
 * It is read through the launch authority the session names, because that is
 * where a managed Agent's environment genuinely lives — the public Terminal
 * contract deliberately never carries it (§14).
 */
const environmentOfLatestPty = (rig: Rig): Readonly<Record<string, string>> => {
  const spec = rig.ptyHost.started[rig.ptyHost.started.length - 1]?.spec;
  if (spec === undefined) return {};
  return rig.authorities.lookup(spec.launchAuthorityRef)?.environment ?? {};
};

for (const mode of ['fresh', 'resume'] as const) {
  test(`a ${mode} continuation re-authenticates the new Run as itself`, async () => {
    const rig = await createRig();
    try {
      const roleProfileId = await rig.roleId(`identity-${mode}`);
      const spawned = await rig.chris.call<RunView>('b3.agent.spawn', {
        roleProfileId, displayName: `Continued ${mode}`, workingDirectory: tmpdir(),
      }, mintClientOpId());
      assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
      if (!spawned.ok) return;

      const first = environmentOfLatestPty(rig);
      assert.equal(first['NVK_AGENT_RUN_ID'], spawned.value.run.id,
        'a spawned Run was not given its own credential');

      const continued = await rig.chris.call<RunView>('b3.agent.continue', {
        agentId: spawned.value.agent.agentId,
        expectedOldRunId: spawned.value.run.id,
        mode,
        configurationMode: 'inherit-plan',
      }, mintClientOpId());
      assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
      if (!continued.ok) return;

      const second = environmentOfLatestPty(rig);
      assert.equal(second['NVK_AGENT_RUN_ID'], continued.value.run.id,
        'the continued Run carries no credential, so anything it runs is Chris');
      assert.equal(
        typeof second['NVK_AGENT_RUN_TOKEN'] === 'string'
        && second['NVK_AGENT_RUN_TOKEN'] !== '',
        true, 'the continued Run carries no run token');
      assert.notEqual(second['NVK_AGENT_RUN_ID'], first['NVK_AGENT_RUN_ID'],
        'the continued Run is impersonating the Run it replaced');
    } finally {
      await rig.close();
    }
  });
}

test('a credential the continued Run was given verifies as that Run', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.roleId('identity-verify');
    const spawned = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'Verified', workingDirectory: tmpdir(),
    }, mintClientOpId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const continued = await rig.chris.call<RunView>('b3.agent.continue', {
      agentId: spawned.value.agent.agentId,
      expectedOldRunId: spawned.value.run.id,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    }, mintClientOpId());
    assert.equal(continued.ok, true, continued.ok ? '' : continued.error.message);
    if (!continued.ok) return;

    // The credential is only real if the door opens with it — and opens as the
    // NEW Run, not as the human.
    const environment = environmentOfLatestPty(rig);
    const asItself = await connectRuntime({
      root: '', port: rig.host.port, token: rig.host.token,
      agentRunId: environment['NVK_AGENT_RUN_ID'] ?? '',
      runToken: environment['NVK_AGENT_RUN_TOKEN'] ?? '',
    });
    try {
      const seen = await asItself.call<{ items: readonly RunView[] }>(
        'b3.agent.listRuns', { includeFinal: true, limit: 10 }, mintClientOpId(),
      );
      assert.equal(seen.ok, true,
        seen.ok ? '' : `the continued Run could not authenticate: ${seen.error.message}`);
    } finally {
      await asItself.close();
    }
  } finally {
    await rig.close();
  }
});

test('half a credential is refused, never downgraded to the human', async () => {
  const rig = await createRig();
  try {
    // NVK-KIMI-028 finding 1: both the client and the CLI suppressed the WHOLE
    // identity unless both halves existed, after which the host saw no claim at
    // all and handed the caller every scope Chris has. A truncated environment
    // — a `ps` read that caught one variable, a shell that exported one — is a
    // broken credential, not an anonymous one.
    for (const half of [
      { agentRunId: 'agentRun_019fbe12-0000-7000-8000-000000000001' },
      { runToken: 'a'.repeat(64) },
    ]) {
      let opened = false;
      try {
        const client = await connectRuntime({
          root: '', port: rig.host.port, token: rig.host.token, ...half,
        });
        opened = true;
        await client.close();
      } catch {
        opened = false;
      }
      assert.equal(opened, false,
        `a connection carrying only ${Object.keys(half)[0]!} was accepted`);
    }
  } finally {
    await rig.close();
  }
});

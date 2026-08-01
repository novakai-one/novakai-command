// What an operator is told when an Agent is already dead (§20, §24.5, red gate 4).
//
// The probe found the two dangerous directions of the same failure:
//
//   - `stop` printed "Stopped Manager4." and exit 0 while stopping nothing,
//     because the stale run it was given was already final and `closeRun` is
//     idempotent — so an operator walked away from a still-billing agent;
//   - a `kill -9`d PTY kept reading `ready, idle` at every surface, for as long
//     as anyone cared to wait, because the Agent layer never reconciles against
//     the Terminal layer directly beneath it.
//
// Red gate 4 exists to stop "no controller attached" collapsing into "stopped".
// These are the opposite collapse, and it is the worse one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost, type FakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { chatRole } from './governed-role.js';

interface RunView {
  agent: { agentId: string };
  run: { id: string; lifecycle: string; activity: string };
  provider: { liveness?: string };
}

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly ptyHost: FakePtyHost;
  role(name: string): Promise<string>;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-dead-'));
  const ptyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, ptyHost,
    async role(name) {
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

test('stopping a stale Run refuses instead of reporting a stop that never happened', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.role('dead-stale');
    const spawned = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'Manager4', workingDirectory: tmpdir(),
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

    // The first Run is final now — replaced by the continuation. Asking to stop
    // it is a compare-and-set that must LOSE, because the Agent's live Run is
    // somebody else.
    const stale = await rig.chris.call('b3.agent.stop', {
      agentId: spawned.value.agent.agentId,
      expectedLiveRunId: spawned.value.run.id,
      confirmation: 'stop-one',
    }, mintClientOpId());
    assert.equal(stale.ok, false,
      'stopping a superseded Run reported success while the live one kept running');
    if (!stale.ok) {
      assert.equal(stale.error.code, 'VersionConflict');
      assert.equal(
        (stale.error.details as { liveAgentRunId?: string }).liveAgentRunId,
        continued.value.run.id,
        'the refusal did not say which Run is actually live');
    }

    // The control: naming the Run that IS live stops it.
    const live = await rig.chris.call('b3.agent.stop', {
      agentId: spawned.value.agent.agentId,
      expectedLiveRunId: continued.value.run.id,
      confirmation: 'stop-one',
    }, mintClientOpId());
    assert.equal(live.ok, true, live.ok ? '' : `the live Run would not stop: ${live.error.code}`);
  } finally {
    await rig.close();
  }
});

test('a Run whose provider process died does not keep reading ready and idle', async () => {
  const rig = await createRig();
  try {
    const roleProfileId = await rig.role('dead-killed');
    const spawned = await rig.chris.call<RunView>('b3.agent.spawn', {
      roleProfileId, displayName: 'Killed', workingDirectory: tmpdir(),
    }, mintClientOpId());
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    assert.equal(spawned.value.run.lifecycle, 'ready');

    // A crash, from the outside: the process is gone and nobody told the
    // Runtime. This is `kill -9` on the provider PID.
    rig.ptyHost.latest().finish({ signal: 'SIGKILL' });

    const seen = await rig.chris.call<RunView>('b3.agent.getRun', {
      agentRunId: spawned.value.run.id,
    }, mintClientOpId());
    assert.equal(seen.ok, true, seen.ok ? '' : seen.error.message);
    if (!seen.ok) return;
    assert.notEqual(
      `${seen.value.run.lifecycle}/${seen.value.run.activity}`, 'ready/idle',
      'a killed Agent still reports "ready, idle"');
  } finally {
    await rig.close();
  }
});

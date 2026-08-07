// §8.1: an exact-Run send is a promise about WHICH provider context reads the
// Message. Once that Run's endpoint has a cutoff the promise cannot be kept, so
// the send fails rather than quietly landing in the successor's inbox.
//
// Messaging keeps that rule. Nothing was ever telling it the Run had ended.
// §13.6's drain runs on CONTINUATION — the path that hands the endpoint to a
// new Run — and a plain stop has no such path, so `closeRun` retired the Run,
// killed its terminal and expired its authorities while leaving the endpoint
// claim `active` with no cutoff. An exact-Run Message aimed at a Run that has
// been stopped was therefore accepted and queued for the Agent: exactly the
// silent redirect §8.1 names, arrived at by never closing the endpoint at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';
import { governedRole } from '../governed-role.js';

interface Rig {
  readonly chris: RuntimeClient;
  close(): Promise<void>;
}

const roots: string[] = [];

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-stopped-'));
  roots.push(root);
  const host: RunningRuntimeHost = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    chris,
    async close() {
      chris.close();
      await host.close();
    },
  };
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('an exact-Run send to a STOPPED Run is refused, not queued for the Agent', async () => {
  const rig = await createRig();
  try {
    const role = await rig.chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('stopped-endpoint'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await rig.chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Stopped', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    const agentRunId = spawned.value.run.id;

    // While it is alive the exact-Run promise CAN be kept, so it is accepted.
    const alive = await rig.chris.call<{ state: string }>('b3.messaging.sendAgent', {
      target: { kind: 'exact-run', agentRunId },
      text: 'while you live', clientMessageId: 'cmid-stopped-alive',
    });
    assert.equal(alive.ok, true, alive.ok ? '' : `${alive.error.code}: ${alive.error.message}`);

    const stopped = await rig.chris.call('b3.agent.stop', {
      agentId: spawned.value.agent.agentId,
      expectedLiveRunId: agentRunId,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : `${stopped.error.code}: ${stopped.error.message}`);

    // The Run is gone. Nobody can read a Message addressed to it, so §8.1's one
    // legitimate refusal is now the only honest answer.
    const after = await rig.chris.call<{ state: string }>('b3.messaging.sendAgent', {
      target: { kind: 'exact-run', agentRunId },
      text: 'after you stopped', clientMessageId: 'cmid-stopped-after',
    });
    assert.equal(after.ok, false,
      `an exact-Run Message aimed at a stopped Run was accepted with state `
      + `"${after.ok ? after.value.state : ''}" instead of being refused`);
    if (after.ok) return;
    assert.equal(after.error.code, 'ExactRunEndpointClosed');
  } finally {
    await rig.close();
  }
});

test('stopping a Run does not stop the AGENT from accepting Messages', async () => {
  const rig = await createRig();
  try {
    const role = await rig.chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('stopped-agent-inbox'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await rig.chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'StoppedInbox', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;

    const stopped = await rig.chris.call('b3.agent.stop', {
      agentId: spawned.value.agent.agentId,
      expectedLiveRunId: spawned.value.run.id,
      confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true);

    // DEC-B3V4-32 is untouched: the AGENT is the durable addressee, and one of
    // its Runs ending is not the Agent going away. Closing the endpoint must
    // narrow the exact-Run promise, never the Agent's inbox.
    const queued = await rig.chris.call<{ state: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: spawned.value.agent.agentId },
      text: 'for whoever comes next', clientMessageId: 'cmid-stopped-agent',
    });
    assert.equal(queued.ok, true,
      queued.ok ? '' : `${queued.error.code}: ${queued.error.message}`);
    if (!queued.ok) return;
    assert.equal(queued.value.state, 'queued-for-agent');
  } finally {
    await rig.close();
  }
});

// Two Messages that must never be committed — §8.2, §17.2, §24.6.
//
// 1. UNKNOWN TARGET. `nvk agent message <unknown-agent> --text x` returned exit
//    0, ok:true, state `queued-for-agent`. A durable inbox item was written for
//    an Agent that has never existed, addressed to nobody, and the CLI told the
//    operator it was queued.
//
// 2. LOOPBACK. §24.6 says "origin loopback does not return to the same
//    endpoint". A mirrored Message passed `recipients: [senderId]`, and
//    `buildAcceptance` maps EVERY recipient to a pending Delivery — so every
//    turn an Agent spoke carried a pending Delivery addressed to its own
//    origin. The shipped test checked only that no `AgentInboxItem` existed,
//    which is exactly the shortcut the implementation took.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';
import { governedRole } from '../governed-role.js';

interface Rig {
  readonly host: RunningRuntimeHost;
  readonly chris: RuntimeClient;
  readonly root: string;
  close(): Promise<void>;
}

async function createRig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-refusals-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    host, chris, root,
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function spawnAgent(rig: Rig, name: string): Promise<string> {
  const role = await rig.chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole(`${name}-role`),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await rig.chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
  if (!spawned.ok) throw new Error('spawn failed');
  return spawned.value.agent.agentId;
}

/** Every committed Messaging operation, straight off the canonical journal. */
function journalOps(root: string): readonly { op: string }[] {
  const file = path.join(root, 'stores', 'messagingStoreOps.jsonl');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line !== '').map((line) => {
    const record = JSON.parse(line) as { payload: { storeOp: { op: string } } };
    return { op: record.payload.storeOp.op };
  });
}

test('a Message to an Agent that does not exist is refused typed, and commits nothing', async () => {
  const rig = await createRig();
  try {
    const real = await spawnAgent(rig, 'real');
    const thread = await rig.chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: real },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    const before = journalOps(rig.root).length;
    const unknown = 'agent_deadbeef-0000-4000-8000-000000000000';
    const sent = await rig.chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: unknown },
      threadId: thread.value.id,
      text: 'is anybody there',
      clientMessageId: 'cmid-unknown-target',
    });

    assert.equal(sent.ok, false,
      'a Message to an Agent that has never existed was accepted and queued');
    if (sent.ok) return;
    // §17.2: a typed ContractError, and one whose code maps to a non-zero exit.
    assert.equal(['UnknownAgent', 'ValidationFailed'].includes(sent.error.code), true,
      `refused with ${sent.error.code}, which is not a typed unknown-target error`);
    assert.equal(sent.error.retryable, false,
      'an Agent that does not exist will not exist on a retry');

    assert.equal(journalOps(rig.root).length, before,
      'the refused send still appended to the canonical Messaging journal');

    // The inbox for the phantom Agent is empty, not merely unread.
    const inbox = await rig.chris.call<{ items: readonly unknown[] }>(
      'b3.messaging.listAgentInbox', { agentId: unknown },
    );
    if (inbox.ok) assert.equal(inbox.value.items.length, 0);
  } finally {
    await rig.close();
  }
});

test('an unknown target does not become reachable by inventing a Thread first', async () => {
  const rig = await createRig();
  try {
    const unknown = 'agent_deadbeef-0000-4000-8000-000000000001';
    const thread = await rig.chris.call('b3.messaging.ensureDirectThread', {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: unknown },
      ],
    });
    // Minting a Thread against a phantom is not itself the defect; committing a
    // Message into it is. Either refusal is acceptable — silence is not.
    if (!thread.ok) return;
    const sent = await rig.chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: unknown },
      threadId: (thread.value as { id: string }).id,
      text: 'still nobody',
      clientMessageId: 'cmid-unknown-thread',
    });
    assert.equal(sent.ok, false, 'a phantom Agent became reachable through its own Thread');
  } finally {
    await rig.close();
  }
});

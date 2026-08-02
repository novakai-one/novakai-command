// §19.2 and red gate 12 — the explicit open, and ONLY the explicit open,
// writes a conversationView record; and the record is a record, not a memory.
//
// Messaging asks a `ConversationViewPort` because Shell owns the
// `conversationView` kind (§18.1). Production composed no port, so it fell back
// to `createMemoryConversationViews` — the default written for "a headless host
// with no sidebar", which every Novakai host quietly became. A deliberate open
// therefore wrote nothing to `conversationViews.jsonl` and did not survive the
// next restart: Chris pins a conversation, restarts, and it is gone.
//
// The capability test could not see this. It composes Messaging directly and
// gets the same in-memory port, so it passes on both sides of the defect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface Rig {
  readonly chris: RuntimeClient;
  readonly host: RunningRuntimeHost;
}

async function open(root: string): Promise<Rig> {
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return { chris, host };
}

async function close(rig: Rig): Promise<void> {
  rig.chris.close();
  await rig.host.close();
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
  assert.equal(spawned.ok, true);
  if (!spawned.ok) throw new Error('spawn failed');
  return spawned.value.agent.agentId;
}

/** Every conversationView record on disk, straight off the canonical file. */
function storedViews(root: string): readonly { id: string; threadRef: { id: string } | null }[] {
  const file = path.join(root, 'stores', 'conversationViews.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as {
      payload: { threadRef: { id: string } | null }; envelope: { id: string };
    }))
    .map((record) => ({ id: record.envelope.id, threadRef: record.payload.threadRef }));
}

test('the explicit open writes a durable conversationView; inspection writes none', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-convview-'));
  let rig = await open(root);
  try {
    const agentId = await spawnAgent(rig, 'Pinned');
    const sent = await rig.chris.call<{ threadId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId }, text: 'hello', clientMessageId: 'cmid-convview-1',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;
    const threadId = sent.value.threadId;

    // Inspection is a READ. Reading an Agent's communications must not pin
    // anything — "an Agent and its communications exist even when no
    // Conversation is pinned in Chris's Messages sidebar" (§19.2).
    const before = storedViews(root).length;
    const seen = await rig.chris.call('b3.messaging.listAgentCommunications', {
      agentIds: [agentId],
    });
    assert.equal(seen.ok, true);
    assert.equal(storedViews(root).length, before,
      'inspecting an Agent\'s communications wrote a conversationView record');

    // The deliberate act.
    const opened = await rig.chris.call<{ threadId: string; open: boolean }>(
      'b3.messaging.openConversation', {
        threadId, membership: { kind: 'direct', agentId },
      },
    );
    assert.equal(opened.ok, true,
      opened.ok ? '' : `${opened.error.code}: ${opened.error.message}`);
    if (!opened.ok) return;

    const after = storedViews(root);
    assert.equal(after.length, before + 1,
      `the explicit open wrote ${String(after.length - before)} conversationView records, not 1`);
    assert.equal(after.some((view) => view.threadRef?.id === threadId), true,
      'the written conversationView does not reference the Thread that was opened');

    // The point of a record: it outlives the process that made it.
    await close(rig);
    rig = await open(root);
    const listed = await rig.chris.call<{ items: readonly { threadId: string; open: boolean }[] }>(
      'b3.messaging.listConversationViews', {},
    );
    assert.equal(listed.ok, true, listed.ok ? '' : `${listed.error.code}: ${listed.error.message}`);
    if (!listed.ok) return;
    const survivor = listed.value.items.find((view) => view.threadId === threadId);
    assert.notEqual(survivor, undefined,
      'the deliberately opened Conversation did not survive a restart');
    assert.equal(survivor?.open, true, 'the Conversation came back closed');
  } finally {
    await close(rig);
    rmSync(root, { recursive: true, force: true });
  }
});

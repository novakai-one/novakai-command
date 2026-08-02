// §19.2's question, asked about the Messages that make it worth asking.
//
// Exam row J4 — "a Message committed before the cutover is still present and
// readable through the canonical route afterwards", `migratedMessages: 0`
// while `publicItems: 5`. The cutover is not the defect. Reading the exam's own
// legacy root back through a fresh Runtime shows all five Messages arriving on
// the canonical route, and four of them readable — and the fifth invisible to
// the ONE Agent it was addressed to:
//
//   sender person_chris · thread <agent A's direct Thread> ·
//   delivery + inbox item for agent B
//
// `listAgentCommunications` scopes by thread MEMBERSHIP — `listThreadsForPerson`
// — and then decides involvement by DELIVERY. A Message addressed to B and
// committed into A's Thread never reaches the second test, because the first
// one never offers the Thread. §19.2's "what has this Agent been sent" answers
// "nothing" for exactly the Message somebody deliberately sent it, and the
// Agent's own durable inbox says otherwise at the same moment.
//
// Nothing about this needs a cutover, which is why it survived one: the read is
// wrong on a store written five seconds ago too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

async function spawn(chris: RuntimeClient, name: string): Promise<string> {
  const role = await chris.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole(`${name}-role`),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true,
    spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
  if (!spawned.ok) throw new Error('spawn failed');
  return spawned.value.agent.agentId;
}

test('a Message sent to an Agent in another Agent\'s Thread is still that Agent\'s Message',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-scope-'));
    const host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const chris = await connectRuntime({ root, port: host.port, token: host.token });
    try {
      const first = await spawn(chris, 'Scoped');
      const second = await spawn(chris, 'Addressee');

      // The first Agent's own conversation.
      const thread = await chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
        between: [
          { kind: 'human', personId: 'person_chris' },
          { kind: 'agent', agentId: first },
        ],
      });
      assert.equal(thread.ok, true);
      if (!thread.ok) return;

      // ...and a Message addressed to the SECOND Agent, committed into it.
      // §12.5 allows exactly this: `threadId` and `target` are two arguments.
      const sent = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId: second },
        threadId: thread.value.id,
        text: 'addressed to the second, filed under the first',
        clientMessageId: 'cmid-cross-thread-1',
      });
      assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
      if (!sent.ok) return;

      // The Agent's own durable inbox holds it — §8.1 accepted it FOR this
      // Agent, so this is not a matter of opinion.
      const inbox = await chris.call<{ items: readonly { messageId: string }[] }>(
        'b3.messaging.listAgentInbox', { agentId: second },
      );
      assert.equal(inbox.ok, true, inbox.ok ? '' : `${inbox.error.code}: ${inbox.error.message}`);
      if (!inbox.ok) return;
      assert.equal(inbox.value.items.some((item) => item.messageId === sent.value.messageId), true,
        'the acceptance is not even in the inbox; this test is asking the wrong question');

      // And §19.2's inspection must agree with it.
      const seen = await chris.call<{ items: readonly { messageId: string }[] }>(
        'b3.messaging.listAgentCommunications', { agentIds: [second], limit: 50 },
      );
      assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
      if (!seen.ok) return;
      assert.equal(seen.value.items.some((item) => item.messageId === sent.value.messageId), true,
        `the Agent's inbox holds this Message and "what has this Agent been sent" returned `
        + `${String(seen.value.items.length)} row(s) without it`);
    } finally {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

test('widening the scope does not duplicate a Message or drag in an unrelated one', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-scope-clean-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const first = await spawn(chris, 'Own');
    const second = await spawn(chris, 'Other');

    const thread = await chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: first },
      ],
    });
    assert.equal(thread.ok, true);
    if (!thread.ok) return;

    // One Message for each Agent, both in the FIRST Agent's Thread.
    const mine = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: first },
      threadId: thread.value.id, text: 'for the first',
      clientMessageId: 'cmid-scope-own',
    });
    const theirs = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: second },
      threadId: thread.value.id, text: 'for the second',
      clientMessageId: 'cmid-scope-other',
    });
    assert.equal(mine.ok && theirs.ok, true);
    if (!mine.ok || !theirs.ok) return;

    const seen = await chris.call<{ items: readonly { messageId: string }[] }>(
      'b3.messaging.listAgentCommunications', { agentIds: [second], limit: 50 },
    );
    assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
    if (!seen.ok) return;
    const ids = seen.value.items.map((item) => item.messageId);
    // Widening the THREAD scope must not widen the INVOLVEMENT rule: the first
    // Agent's Message shares the Thread and is not the second Agent's business.
    assert.equal(ids.includes(mine.value.messageId), false,
      'widening the thread scope dragged in a Message addressed to another Agent');
    assert.equal(ids.filter((id) => id === theirs.value.messageId).length, 1,
      `the Message appears ${String(ids.filter((id) => id === theirs.value.messageId).length)} `
      + 'times: the widened scope is returning the same row twice');
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// What a client sees AFTER a send succeeds — §8.1, §12.5, §19.2.
//
// Two hold-out exam failures, asked here through the same door the exam used:
// nothing but published `b3.*` methods.
//
//   E2  A send returned `ok:true`, and the read-back that followed showed no
//       communication row and no inbox state. An acceptance nobody can observe
//       is indistinguishable from a send that silently did nothing.
//
//   E3  `sendAgent` with `target: {kind:"exact-run"}` was REJECTED for a Run
//       that was alive at that moment. §8.1 gives exact-run one legitimate
//       refusal — the Run's endpoint has a cutoff — and a live Run has none.
//
// Both are read as a CLIENT reads them: no store, no capability import, no
// hand-built state. If production does not put it on the wire, this test cannot
// see it, which is the point.
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

interface Spawned {
  readonly agentId: string;
  readonly agentRunId: string;
}

interface Rig {
  readonly chris: RuntimeClient;
  readonly root: string;
  spawn(name: string): Promise<Spawned>;
  /** Stop the Runtime and start a new one on the same root — a restart, not a reset. */
  restart(): Promise<Rig>;
  close(): Promise<void>;
}

async function createRig(existingRoot?: string): Promise<Rig> {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), 'nvk-b3c-readback-'));
  const host: RunningRuntimeHost = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  return {
    chris,
    root,
    async restart() {
      chris.close();
      await host.close();
      return createRig(root);
    },
    async spawn(name) {
      const role = await chris.call<{ id: string }>('b3.agent.createRole', {
        ...governedRole(`${name}-role`),
        skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      });
      assert.equal(role.ok, true);
      if (!role.ok) throw new Error('createRole failed');
      const spawned = await chris.call<{
        agent: { agentId: string }; run: { id: string };
      }>('b3.agent.spawn', {
        roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
      });
      assert.equal(spawned.ok, true,
        spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
      if (!spawned.ok) throw new Error('spawn failed');
      return { agentId: spawned.value.agent.agentId, agentRunId: spawned.value.run.id };
    },
    async close() {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function directThread(rig: Rig, agentId: string): Promise<string> {
  const thread = await rig.chris.call<{ id: string }>('b3.messaging.ensureDirectThread', {
    between: [
      { kind: 'human', personId: 'person_chris' },
      { kind: 'agent', agentId },
    ],
  });
  assert.equal(thread.ok, true, thread.ok ? '' : `${thread.error.code}: ${thread.error.message}`);
  if (!thread.ok) throw new Error('ensureDirectThread failed');
  return thread.value.id;
}

interface CommunicationRow {
  readonly messageId: string;
  readonly direction: string;
  readonly textPreview: string;
  readonly recipientAgentIds: readonly string[];
}

test('a send that says accepted is visible in the read-back that follows it', async () => {
  const rig = await createRig();
  try {
    const agent = await rig.spawn('Readback');
    const threadId = await directThread(rig, agent.agentId);

    const sent = await rig.chris.call<{ messageId: string; state: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId: agent.agentId },
        threadId, text: 'status please', clientMessageId: 'cmid-readback-1',
      },
    );
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    // 1. The communication row. §19.2's inspection surface is the answer to
    //    "what has this Agent been sent", and an acceptance that never appears
    //    on it cannot be inspected, audited, or shown in a Conversation.
    const seen = await rig.chris.call<{ items: readonly CommunicationRow[] }>(
      'b3.messaging.listAgentCommunications', { agentIds: [agent.agentId] },
    );
    assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
    if (!seen.ok) return;
    const row = seen.value.items.find((item) => item.messageId === sent.value.messageId);
    assert.notEqual(row, undefined,
      `the accepted Message is absent from listAgentCommunications `
      + `(${String(seen.value.items.length)} row(s) returned)`);
    assert.equal(row?.direction, 'to-agent');
    assert.equal(row?.recipientAgentIds.includes(agent.agentId), true,
      'the row does not name the Agent the Message was addressed to');

    // 2. The inbox state. §8.1 accepts INTO a durable inbox, so `queued-for-agent`
    //    is a claim about a record that has to be readable.
    assert.equal(sent.value.state, 'queued-for-agent');
    const inbox = await rig.chris.call<{
      items: readonly { messageId: string; state: string }[];
    }>('b3.messaging.listAgentInbox', { agentId: agent.agentId });
    assert.equal(inbox.ok, true, inbox.ok ? '' : `${inbox.error.code}: ${inbox.error.message}`);
    if (!inbox.ok) return;
    const item = inbox.value.items.find((entry) => entry.messageId === sent.value.messageId);
    assert.notEqual(item, undefined,
      `the acceptance reported state "queued-for-agent" but the Agent's inbox holds `
      + `${String(inbox.value.items.length)} item(s) for it`);
  } finally {
    await rig.close();
  }
});

test('a client holding only the published send contract can send a Message', async () => {
  const rig = await createRig();
  try {
    const agent = await rig.spawn('NoThread');

    // No `ensureDirectThread` first. §12.5 requires a ThreadId and §16.2
    // publishes no method that mints one, so this is every send a client
    // holding the complete published contract can make — and every one of them
    // answered `ValidationFailed: threadId must be a thread_ id`.
    const sent = await rig.chris.call<{ messageId: string; threadId: string; state: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId: agent.agentId },
        text: 'no thread, no ceremony', clientMessageId: 'cmid-threadless-1',
      },
    );
    assert.equal(sent.ok, true,
      sent.ok ? '' : `a send with no threadId was refused: ${sent.error.code} — ${sent.error.message}`);
    if (!sent.ok) return;
    // The acceptance NAMES the conversation it resolved, so the caller who did
    // not know a Thread now does.
    assert.equal(sent.value.threadId.startsWith('thread_'), true,
      `the acceptance did not name the resolved Thread: ${String(sent.value.threadId)}`);

    // The same sender and Agent resolve to the SAME conversation next time —
    // otherwise every threadless send would start a new one.
    const again = await rig.chris.call<{ threadId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: agent.agentId },
      text: 'and again', clientMessageId: 'cmid-threadless-2',
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.value.threadId, sent.value.threadId,
      'two threadless sends to the same Agent landed in two different conversations');

    // A malformed Thread is still a refusal: naming one means naming one.
    const wrong = await rig.chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: agent.agentId },
      threadId: 'not-a-thread', text: 'x', clientMessageId: 'cmid-threadless-3',
    });
    assert.equal(wrong.ok, false, 'a malformed threadId was accepted');
  } finally {
    await rig.close();
  }
});

// The combination the suite above never crosses: a client that does not know a
// Thread sends, and then asks what happened. Each half is covered — the
// threadless send, and the read-back after a send that named a Thread — and the
// exam still failed E2, because the defect lives only where they meet.
test('the read-back after a THREADLESS send shows the Message it accepted', async () => {
  const rig = await createRig();
  try {
    const agent = await rig.spawn('ThreadlessReadback');

    const sent = await rig.chris.call<{ messageId: string; threadId: string; state: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId: agent.agentId },
        text: 'status please', clientMessageId: 'cmid-threadless-readback-1',
      },
    );
    assert.equal(sent.ok, true,
      sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    const seen = await rig.chris.call<{ items: readonly CommunicationRow[] }>(
      'b3.messaging.listAgentCommunications', { agentIds: [agent.agentId] },
    );
    assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
    if (!seen.ok) return;
    assert.notEqual(
      seen.value.items.find((item) => item.messageId === sent.value.messageId), undefined,
      `a threadless send reported ${sent.value.state} on thread ${sent.value.threadId}, and `
      + `listAgentCommunications returned ${String(seen.value.items.length)} row(s) for the Agent`,
    );

    const inbox = await rig.chris.call<{
      items: readonly { messageId: string; state: string }[];
    }>('b3.messaging.listAgentInbox', { agentId: agent.agentId });
    assert.equal(inbox.ok, true, inbox.ok ? '' : `${inbox.error.code}: ${inbox.error.message}`);
    if (!inbox.ok) return;
    assert.notEqual(
      inbox.value.items.find((entry) => entry.messageId === sent.value.messageId), undefined,
      `the acceptance reported state "${sent.value.state}" and the Agent's inbox holds `
      + `${String(inbox.value.items.length)} item(s)`,
    );

    // §19.2's other question: "what has THIS shift been sent". The acceptance
    // named a live Run as the delivery target, so the Message it committed is
    // related to that Run — a caller who narrows to it must not be told the
    // Agent received nothing.
    const forRun = await rig.chris.call<{ items: readonly CommunicationRow[] }>(
      'b3.messaging.listAgentCommunications',
      { agentIds: [agent.agentId], runIds: [agent.agentRunId] },
    );
    assert.equal(forRun.ok, true, forRun.ok ? '' : `${forRun.error.code}: ${forRun.error.message}`);
    if (!forRun.ok) return;
    assert.notEqual(
      forRun.value.items.find((item) => item.messageId === sent.value.messageId), undefined,
      `narrowing the same read to the Run the Message was queued for returned `
      + `${String(forRun.value.items.length)} row(s)`,
    );
  } finally {
    await rig.close();
  }
});

test('an acceptance survives a Runtime restart, inbox state and all', async () => {
  let rig = await createRig();
  try {
    const agent = await rig.spawn('Durable');
    const threadId = await directThread(rig, agent.agentId);
    const sent = await rig.chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: agent.agentId },
      threadId, text: 'still here after a restart?', clientMessageId: 'cmid-durable-1',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    // §8.1's inbox is DURABLE: "accepted and queued" is a promise that outlives
    // the process that made it. A restart is the cheapest way to tell a real
    // commit apart from a process-memory index that reads back correctly until
    // the first one.
    rig = await rig.restart();

    const seen = await rig.chris.call<{ items: readonly CommunicationRow[] }>(
      'b3.messaging.listAgentCommunications', { agentIds: [agent.agentId] },
    );
    assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
    if (!seen.ok) return;
    assert.equal(seen.value.items.some((item) => item.messageId === sent.value.messageId), true,
      'the acceptance is gone from the read-back after a restart');

    const inbox = await rig.chris.call<{
      items: readonly { messageId: string; state: string }[];
    }>('b3.messaging.listAgentInbox', { agentId: agent.agentId });
    assert.equal(inbox.ok, true, inbox.ok ? '' : `${inbox.error.code}: ${inbox.error.message}`);
    if (!inbox.ok) return;
    assert.equal(inbox.value.items.some((item) => item.messageId === sent.value.messageId), true,
      'the queued inbox item did not survive the restart');
  } finally {
    await rig.close();
  }
});

test('an exact-run send is accepted while that Run is alive', async () => {
  const rig = await createRig();
  try {
    const agent = await rig.spawn('ExactRun');
    const threadId = await directThread(rig, agent.agentId);

    // The Run was spawned moments ago through the published wire and nothing has
    // stopped it, so §8.1's only exact-run refusal — a cutoff on that Run's
    // endpoint — cannot apply.
    const sent = await rig.chris.call<{ messageId: string; state: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'exact-run', agentRunId: agent.agentRunId },
        threadId, text: 'this exact shift, please', clientMessageId: 'cmid-exact-1',
      },
    );
    assert.equal(sent.ok, true,
      sent.ok ? '' : `an exact-run send to a LIVE Run was refused: `
        + `${sent.error.code} — ${sent.error.message}`);
    if (!sent.ok) return;

    // And it is attributed to the Run it named — otherwise "exact-run" bought
    // the caller nothing over a plain Agent send.
    const seen = await rig.chris.call<{
      items: readonly (CommunicationRow & { relatedRunIds: readonly string[] })[];
    }>('b3.messaging.listAgentCommunications', { agentIds: [agent.agentId] });
    assert.equal(seen.ok, true);
    if (!seen.ok) return;
    const row = seen.value.items.find((item) => item.messageId === sent.value.messageId);
    assert.notEqual(row, undefined, 'the exact-run acceptance is absent from the read-back');
    assert.equal(row?.relatedRunIds.includes(agent.agentRunId), true,
      `the row does not relate the Message to the Run it was addressed to `
      + `(relatedRunIds: ${JSON.stringify(row?.relatedRunIds)})`);
  } finally {
    await rig.close();
  }
});

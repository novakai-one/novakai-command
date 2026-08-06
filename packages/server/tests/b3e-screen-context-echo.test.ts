// L-10 / B3R-007: AMD-004's `screenContext` echo, asked through the door.
//
// The amendment adds ONE optional field and a law about it (pass2 §10, applied
// 2026-08-06):
//
//   "A `ScreenContext` accepted on `SendAgentMessageInput` is persisted
//    verbatim on the committed `Message` inside the `acceptance` StoreOp and is
//    echoed unchanged on the published `AgentCommunicationItem` projection;
//    Messaging is the sole authority for that echo and no Shell view-model
//    recomputes or supplies it. A Message committed through
//    `CommitTerminalOriginatedMessageInput` has no `screenContext`. When
//    `support` is `unavailable`, `contentRef` MUST be absent."
//
// None of it existed: the word appeared in no file under packages/messaging, so
// `SendAgentMessageInput` could not accept one and `AgentCommunicationItem`
// could not carry one. Any exam row reading an echo scored BLIND.
//
// Every assertion below rides published `b3.*` methods only — if production
// does not put it on the wire, this test cannot see it. VERBATIM is the load-
// bearing word, so the echo is compared with `deepEqual` against the exact
// object that was sent, never field by field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface Rig {
  readonly chris: RuntimeClient;
  readonly root: string;
  spawn(name: string): Promise<string>;
  restart(): Promise<Rig>;
  close(): Promise<void>;
}

async function createRig(existingRoot?: string): Promise<Rig> {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), 'nvk-b3e-screenctx-'));
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
      const spawned = await chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
        roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
      });
      assert.equal(spawned.ok, true,
        spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
      if (!spawned.ok) throw new Error('spawn failed');
      return spawned.value.agent.agentId;
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
    between: [{ kind: 'human', personId: 'person_chris' }, { kind: 'agent', agentId }],
  });
  assert.equal(thread.ok, true, thread.ok ? '' : `${thread.error.code}: ${thread.error.message}`);
  if (!thread.ok) throw new Error('ensureDirectThread failed');
  return thread.value.id;
}

interface CommunicationRow {
  readonly messageId: string;
  readonly screenContext?: Record<string, unknown>;
}

/** A snapshot capture, with every §10 member populated including the optional one. */
const SNAPSHOT = {
  captureId: 'capture-b3e-0001',
  capturedAt: '2026-08-06T09:15:00.000Z',
  source: 'novakai-window',
  support: 'snapshot',
  advisoryOnly: true,
  contentRef: 'artifact_screen_0001',
  limitations: ['the composer was mid-keystroke', 'one panel was scrolled out of view'],
} as const;

async function rowFor(
  rig: Rig, agentId: string, messageId: string,
): Promise<CommunicationRow | undefined> {
  const seen = await rig.chris.call<{ items: readonly CommunicationRow[] }>(
    'b3.messaging.listAgentCommunications', { agentIds: [agentId] },
  );
  assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
  if (!seen.ok) return undefined;
  return seen.value.items.find((item) => item.messageId === messageId);
}

test('AMD-004: a ScreenContext sent with a Message is echoed back verbatim', async () => {
  const rig = await createRig();
  try {
    const agentId = await rig.spawn('Screener');
    const threadId = await directThread(rig, agentId);

    const sent = await rig.chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'what do you make of this?', clientMessageId: 'cmid-screenctx-1',
      screenContext: SNAPSHOT,
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    const row = await rowFor(rig, agentId, sent.value.messageId);
    assert.notEqual(row, undefined, 'the Message is absent from listAgentCommunications');
    // Verbatim, as one object. Field-by-field would pass a projection that
    // rebuilt the context from parts, which is exactly what §10 forbids.
    assert.deepEqual(row?.screenContext, { ...SNAPSHOT });
  } finally {
    await rig.close();
  }
});

test('AMD-004: the echo is durable — it survives a Runtime restart', async () => {
  // "Persisted verbatim on the committed Message inside the acceptance StoreOp"
  // is the load-bearing clause. A context held in memory would echo correctly
  // in the test above and be gone by morning.
  let rig = await createRig();
  try {
    const agentId = await rig.spawn('Durable');
    const threadId = await directThread(rig, agentId);
    const sent = await rig.chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'look at this before you answer', clientMessageId: 'cmid-screenctx-2',
      screenContext: SNAPSHOT,
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    rig = await rig.restart();
    const row = await rowFor(rig, agentId, sent.value.messageId);
    assert.deepEqual(row?.screenContext, { ...SNAPSHOT },
      'the ScreenContext did not survive the restart — it is not in the StoreOp');
  } finally {
    await rig.close();
  }
});

test('AMD-004: a Message sent without one carries no screenContext at all', async () => {
  // Absent, not an empty object and not a null. The field's absence is what
  // says "this Message was composed without a screen", and a hollow one would
  // be a snapshot of nothing presented as a snapshot.
  const rig = await createRig();
  try {
    const agentId = await rig.spawn('Bare');
    const threadId = await directThread(rig, agentId);
    const sent = await rig.chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'no screen here', clientMessageId: 'cmid-screenctx-3',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    const row = await rowFor(rig, agentId, sent.value.messageId);
    assert.notEqual(row, undefined, 'the Message is absent from listAgentCommunications');
    assert.equal('screenContext' in (row ?? {}), false,
      `an unasked-for screenContext appeared: ${JSON.stringify(row?.screenContext)}`);
  } finally {
    await rig.close();
  }
});

test('AMD-004: `support: "unavailable"` with a contentRef is refused', async () => {
  // The one MUST in the amendment's own text. `unavailable` means there is no
  // capture; a reference to one alongside it is a contradiction, and accepting
  // it would put a Message on the record claiming evidence that cannot exist.
  const rig = await createRig();
  try {
    const agentId = await rig.spawn('Contradiction');
    const threadId = await directThread(rig, agentId);
    const refused = await rig.chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'this should not land', clientMessageId: 'cmid-screenctx-4',
      screenContext: {
        captureId: 'capture-b3e-0002', capturedAt: '2026-08-06T09:20:00.000Z',
        source: 'unavailable', support: 'unavailable', advisoryOnly: true,
        contentRef: 'artifact_that_cannot_exist', limitations: [],
      },
    });
    assert.equal(refused.ok, false, 'an unavailable capture with a contentRef was accepted');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'ValidationFailed');
    assert.ok(
      (refused.error.details['issues'] as readonly { path: string }[] | undefined)
        ?.some((issue) => issue.path.includes('contentRef')),
      `the refusal does not name contentRef: ${JSON.stringify(refused.error.details)}`,
    );

    // And the same capture WITHOUT the contradiction is accepted — so the rule
    // is the contradiction, not a blanket refusal of `unavailable`.
    const accepted = await rig.chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'no screen was available', clientMessageId: 'cmid-screenctx-5',
      screenContext: {
        captureId: 'capture-b3e-0003', capturedAt: '2026-08-06T09:21:00.000Z',
        source: 'unavailable', support: 'unavailable', advisoryOnly: true,
        limitations: ['the window was not on screen'],
      },
    });
    assert.equal(accepted.ok, true,
      accepted.ok ? '' : `${accepted.error.code}: ${accepted.error.message}`);
    if (!accepted.ok) return;
    const row = await rowFor(rig, agentId, accepted.value.messageId);
    assert.equal(row?.screenContext?.['support'], 'unavailable');
    assert.equal('contentRef' in (row?.screenContext ?? {}), false);
  } finally {
    await rig.close();
  }
});

test('AMD-004: a malformed ScreenContext is refused, not quietly dropped', async () => {
  // The alternative failure is worse than a refusal: a send that succeeds while
  // silently discarding the screen leaves the sender believing the Agent can
  // see what they were looking at.
  const rig = await createRig();
  try {
    const agentId = await rig.spawn('Malformed');
    const threadId = await directThread(rig, agentId);
    const refused = await rig.chris.call('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId },
      threadId, text: 'bad context', clientMessageId: 'cmid-screenctx-6',
      screenContext: { captureId: 'capture-b3e-0004', source: 'telepathy' },
    });
    assert.equal(refused.ok, false, 'a malformed ScreenContext was accepted');
    if (refused.ok) return;
    assert.equal(refused.error.code, 'ValidationFailed');
  } finally {
    await rig.close();
  }
});

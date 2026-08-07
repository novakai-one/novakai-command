// B3c — the §16.2 messaging/transcript methods, and the ones that make them
// usable (hold-out surfaces 1–5, 7).
//
// §16.2 names six. The pre-build hold-out exam proved six is not enough to
// reach from outside: `threadId` is required by send and open, and nothing in
// the spec mints a Thread — so a second host could compile a request it could
// never legally fill in. These tests drive the real wire table end to end,
// starting from nothing, exactly as that host would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime, type RuntimeClient } from '../../core/b3/client.js';
import { governedRole } from '../governed-role.js';
import { buildB3MessagingMethods } from '../../core/b3/messaging-methods.js';
import type { MethodTable } from '../../contract/protocol.js';

/** The six §16.2 names, verbatim, plus the seven that make them reachable. */
const PUBLISHED = [
  'b3.messaging.sendAgent',
  'b3.messaging.listAgentCommunications',
  'b3.messaging.openConversation',
  'b3.transcript.getBinding',
  'b3.transcript.listObservedSubagents',
  'b3.transcript.promoteObservedSubagent',
] as const;

const REACHABILITY = [
  'b3.messaging.ensureDirectThread',
  'b3.messaging.ensureGroupThread',
  'b3.messaging.listAgentInbox',
  'b3.messaging.getAgentEndpoint',
  'b3.messaging.listConversationViews',
  'b3.messaging.closeConversation',
  'b3.transcript.ingest',
] as const;

interface Rig {
  readonly table: MethodTable;
  readonly root: string;
  /** Two REAL Agents, spawned through the published wire. */
  readonly agentId: string;
  readonly otherAgentId: string;
  close(): Promise<void>;
}

/**
 * These ids used to be two constants that had never been created. That passed
 * only while `sendAgentMessage` accepted a Message for an Agent nobody had
 * spawned — the hole P0-5 closed — so the tests were proving the wire could
 * reach a state production now refuses. They spawn for real instead: a
 * reachability test that starts from an Agent the product never made is not
 * starting from nothing, it is starting from a fiction.
 */
async function spawnAgent(client: RuntimeClient, name: string): Promise<string> {
  const role = await client.call<{ id: string }>('b3.agent.createRole', {
    ...governedRole(`${name}-role`),
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
  assert.equal(role.ok, true, role.ok ? '' : role.error.message);
  if (!role.ok) throw new Error('createRole failed');
  const spawned = await client.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
    roleProfileId: role.value.id, displayName: name, workingDirectory: tmpdir(),
  });
  assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
  if (!spawned.ok) throw new Error('spawn failed');
  return spawned.value.agent.agentId;
}

async function rig(): Promise<Rig> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-published-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  const agentId = await spawnAgent(client, 'Published');
  const otherAgentId = await spawnAgent(client, 'PublishedOther');
  client.close();
  const table = buildB3MessagingMethods({
    messaging: host.runtime.messaging,
    transcript: host.runtime.transcript,
    // This table's caller is always Chris, so the Run→Agent join is never
    // consulted; it is here because the option is not optional, and an
    // always-null answer is the honest value for "no Agent Run is calling".
    agentOfRun: async () => null,
    principalFor: () => ({ id: 'person_chris' as never, kind: 'human', verifiedScopes: [] }),
    contextFor: (principal, _session, clientOpId) => ({
      principal, clientOpId, traceId: 'trace_x' as never, contractVersion: 1,
    }),
  });
  return {
    table, root, agentId, otherAgentId,
    async close() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const call = async (
  table: MethodTable, method: string, payload: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: { code: string } }> => {
  const handler = table[method];
  assert.notEqual(handler, undefined, `${method} is not on the wire`);
  return await handler!({ contractVersion: 1, payload } as never) as never;
};

test('every §16.2 messaging/transcript method is on the table by its published name', async () => {
  const harness = await rig();
  try {
    const missing = PUBLISHED.filter((name) => !(name in harness.table));
    assert.deepEqual(missing, [], 'methods §16.2 publishes are not on the wire');
  } finally {
    await harness.close();
  }
});

test('the surfaces that make those six usable are published too', async () => {
  const harness = await rig();
  try {
    const missing = REACHABILITY.filter((name) => !(name in harness.table));
    assert.deepEqual(missing, [],
      'the six §16.2 methods are unreachable without these');
  } finally {
    await harness.close();
  }
});

test('a caller starting from nothing can mint a Thread and send a Message', async () => {
  // The hold-out blocker, end to end and over the wire: no Thread exists, and
  // the caller has only an AgentId.
  const harness = await rig();
  const AGENT = harness.agentId;
  try {
    const thread = await call(harness.table, 'b3.messaging.ensureDirectThread', {
      between: [
        { kind: 'human', personId: 'person_chris' },
        { kind: 'agent', agentId: AGENT },
      ],
    });
    assert.equal(thread.ok, true, JSON.stringify(thread));
    const threadId = (thread.value as { id: string }).id;
    assert.match(threadId, /^thread_/);

    const sent = await call(harness.table, 'b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: AGENT },
      threadId,
      text: 'ping',
      clientMessageId: 'cmid-1',
    });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal((sent.value as { state: string }).state, 'queued-for-agent');

    const inbox = await call(harness.table, 'b3.messaging.listAgentInbox', {
      agentId: AGENT,
    });
    assert.equal(inbox.ok, true);
    assert.equal((inbox.value as { items: unknown[] }).items.length, 1);
  } finally {
    await harness.close();
  }
});

test('reading two Agents talk does not pin a conversation; opening one does', async () => {
  const harness = await rig();
  const AGENT = harness.agentId;
  const other = harness.otherAgentId;
  try {
    const thread = await call(harness.table, 'b3.messaging.ensureDirectThread', {
      between: [{ kind: 'agent', agentId: AGENT }, { kind: 'agent', agentId: other }],
    });
    const threadId = (thread.value as { id: string }).id;
    await call(harness.table, 'b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: other },
      threadId, text: 'status?', clientMessageId: 'cmid-1',
    });

    const listed = await call(harness.table, 'b3.messaging.listAgentCommunications', {
      agentIds: [AGENT, other], limit: 50,
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal((listed.value as { items: unknown[] }).items.length, 1);

    const beforeOpen = await call(harness.table, 'b3.messaging.listConversationViews', {});
    assert.equal((beforeOpen.value as { items: unknown[] }).items.length, 0,
      'inspecting an Agent conversation pinned it to the sidebar');

    const opened = await call(harness.table, 'b3.messaging.openConversation', {
      threadId, membership: { kind: 'group', agentIds: [AGENT, other] },
    });
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const afterOpen = await call(harness.table, 'b3.messaging.listConversationViews', {});
    assert.equal((afterOpen.value as { items: unknown[] }).items.length, 1);
  } finally {
    await harness.close();
  }
});

test('a malformed payload is a typed ValidationFailed, never a throw', async () => {
  const harness = await rig();
  try {
    const noTarget = await call(harness.table, 'b3.messaging.sendAgent', {
      threadId: 'thread_x', text: 'hi',
    });
    assert.equal(noTarget.ok, false);
    assert.equal(noTarget.error?.code, 'ValidationFailed');

    const oneParticipant = await call(harness.table, 'b3.messaging.ensureDirectThread', {
      between: [{ kind: 'agent', agentId: harness.agentId }],
    });
    assert.equal(oneParticipant.ok, false);
    assert.equal(oneParticipant.error?.code, 'ValidationFailed');
  } finally {
    await harness.close();
  }
});

test('an unsupported contractVersion is refused before the payload is read', async () => {
  const harness = await rig();
  try {
    const handler = harness.table['b3.messaging.sendAgent'];
    const refused = await handler!({
      contractVersion: 2, payload: { anything: true },
    } as never) as { ok: boolean; error?: { code: string } };
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, 'UnsupportedContractVersion');
  } finally {
    await harness.close();
  }
});

test('an unknown Run is a typed refusal from getBinding, not an empty success', async () => {
  const harness = await rig();
  try {
    const missing = await call(harness.table, 'b3.transcript.getBinding', {
      agentRunId: 'agentRun_01900000-0000-7000-8000-00000000dead',
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'UnknownAgentRun');
  } finally {
    await harness.close();
  }
});

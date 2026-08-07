// The other half of "messages are messages" — §8.1, §13.4, §20.
//
// Exam row E2: "the accepted Message commits exactly once and its inbox item
// reaches a named submitted/observed/uncertain state" —
// `{"acceptances":0,"inboxStates":[],"uncertain":false}`.
//
// Shift 3 fixed one cause (the `runIds` filter). The second is structural, and
// `grep` says it in one line: `claimNextInboxItem` and `recordInboxSubmission`
// are published on the Messaging contract and typed to `sys_agent_runtime`, and
// their only caller in this repository is a Messaging capability test. Nothing
// in production ever claims a queued item or types it into the Agent's
// terminal, so §8.1's six inbox states have exactly one reachable member and a
// read filtered to the delivered ones is empty by construction.
//
// This test sends through the wire and then only waits. Every assertion is
// about what production does on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost, type FakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime } from '../../core/b3/client.js';
import { governedRole } from '../governed-role.js';

const DELIVERED: readonly string[] = [
  'submitted-confirmed', 'submitted-unconfirmed', 'transcript-observed',
];

const TEXT = 'please summarise the runtime changes';

interface InboxItem {
  readonly messageId: string;
  readonly state: string;
  readonly endpointClaimId?: string;
  readonly terminalInputAttemptId?: string;
}

async function until<T>(
  attempt: () => Promise<T | null>, budgetMs: number,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await attempt();
    if (found !== null) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('an accepted Message is typed into the Agent\'s terminal with nobody asking', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-delivery-'));
  const ptyHost: FakePtyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('delivery-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Delivery', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;

    const sent = await chris.call<{ messageId: string; state: string }>(
      'b3.messaging.sendAgent', {
        target: { kind: 'agent', agentId: spawned.value.agent.agentId },
        text: TEXT, clientMessageId: 'cmid-delivery-1',
      },
    );
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;
    assert.equal(sent.value.state, 'queued-for-agent');

    // §8.1's promise, read exactly as E2 reads it: the item reaches a NAMED
    // delivered state. `queued` for ever is the acceptance never being kept.
    const delivered = await until(async () => {
      const inbox = await chris.call<{ items: readonly InboxItem[] }>(
        'b3.messaging.listAgentInbox', {
          agentId: spawned.value.agent.agentId, states: DELIVERED,
        },
      );
      if (!inbox.ok) return null;
      return inbox.value.items.find((item) => item.messageId === sent.value.messageId) ?? null;
    }, 15_000);

    assert.notEqual(delivered, null,
      'the acceptance said "queued-for-agent" and the item never left `queued`: '
      + 'nothing in production delivers an inbox item');
    // §20: keystrokes reaching a PTY is not the provider having read them, so
    // `submitted-unconfirmed` is the honest outcome — never a confirmed one the
    // Runtime cannot observe.
    assert.equal(DELIVERED.includes(delivered!.state), true);
    assert.notEqual(delivered!.endpointClaimId, undefined,
      'a delivered item does not name the endpoint claim it was delivered through');

    // The state is not the point on its own — the TEXT has to have reached the
    // terminal. A state machine that advances without typing anything is the
    // most expensive way to lose a Message.
    const typed = ptyHost.started.some((session) =>
      session.written.join('').includes(TEXT));
    assert.equal(typed, true,
      'the inbox item was marked delivered and the Message text never reached any PTY');
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a delivered item is not delivered a second time', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-delivery-once-'));
  const ptyHost: FakePtyHost = createFakePtyHost();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: createFakeProviderAdapters(),
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('delivery-once-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{ agent: { agentId: string } }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'DeliveryOnce', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;

    const sent = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId: spawned.value.agent.agentId },
      text: TEXT, clientMessageId: 'cmid-delivery-once',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    const found = await until(async () => {
      const inbox = await chris.call<{ items: readonly InboxItem[] }>(
        'b3.messaging.listAgentInbox', {
          agentId: spawned.value.agent.agentId, states: DELIVERED,
        },
      );
      if (!inbox.ok) return null;
      return inbox.value.items.find((item) => item.messageId === sent.value.messageId) ?? null;
    }, 15_000);
    assert.notEqual(found, null, 'the item never reached a delivered state');

    // §20's hard rule: a `submitted-unconfirmed` item must never be handed out
    // again — its keystrokes already reached the PTY. Several more pump ticks
    // pass here, and the count must not move.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const occurrences = ptyHost.started
      .map((session) => session.written.join('').split(TEXT).length - 1)
      .reduce((total, count) => total + count, 0);
    assert.equal(occurrences, 1,
      `one accepted Message was typed into a PTY ${String(occurrences)} times`);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

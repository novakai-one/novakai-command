// §19.2's "what has this shift been sent" — exam row E2, third cause.
//
// E2 read `{"acceptances":0,"inboxStates":[],"uncertain":false}` for a Message
// the store plainly holds. Shift 1 found the first cause (`runIds` was declared
// and never read) and wired the filter; that made the second one visible.
//
// A queued inbox item carries no `endpointClaimId` — the Runtime stamps it when
// it CLAIMS the item for delivery — so `relatedRunIds` is inferred from the
// Agent's current endpoint. The inference only accepted an ACTIVE claim. A Run
// that has stopped drains its endpoint (§13.6 row 1), so from that moment every
// Message still waiting in that Agent's inbox reported no related Run at all,
// and a run-filtered read — the read §19.2 exists for — answered "nothing" for
// mail it was holding.
//
// That is the exact shape of what the exam saw against the run it was asking
// about: the Message is durable, the inbox item is durable, and the surface
// that answers "what was this shift sent" returns an empty page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

interface CommunicationItem {
  readonly messageId: string;
  readonly relatedRunIds: readonly string[];
}

test('mail queued for a shift stays visible to that shift after its Run stops', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-shift-mail-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    // Off: this row is about what a READ says, and a delivery that stamps
    // `endpointClaimId` would answer the question by a different route.
    inboxDeliveryIntervalMs: 3_600_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('shift-mail-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'ShiftMail', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;
    const { agentId } = spawned.value.agent;
    const runId = spawned.value.run.id;

    const sent = await chris.call<{ messageId: string }>('b3.messaging.sendAgent', {
      target: { kind: 'agent', agentId }, text: 'read this when you get in',
      clientMessageId: 'cmid-shift-mail',
    });
    assert.equal(sent.ok, true, sent.ok ? '' : `${sent.error.code}: ${sent.error.message}`);
    if (!sent.ok) return;

    const askAboutRun = async (): Promise<readonly CommunicationItem[]> => {
      const page = await chris.call<{ items: readonly CommunicationItem[] }>(
        'b3.messaging.listAgentCommunications',
        { agentIds: [agentId], runIds: [runId], limit: 50 },
      );
      assert.equal(page.ok, true, page.ok ? '' : `${page.error.code}: ${page.error.message}`);
      return page.ok ? page.value.items : [];
    };

    const whileLive = await askAboutRun();
    assert.equal(whileLive.some((item) => item.messageId === sent.value.messageId), true,
      'a Message queued for a live shift was already invisible to it');

    const stopped = await chris.call('b3.agent.stop', {
      agentId, expectedLiveRunId: runId, confirmation: 'stop-one',
    });
    assert.equal(stopped.ok, true, stopped.ok ? '' : `${stopped.error.code}: ${stopped.error.message}`);

    // The Message did not move, and neither did the inbox item. Only the
    // endpoint stopped being `active`.
    const inbox = await chris.call<{ items: readonly { messageId: string; state: string }[] }>(
      'b3.messaging.listAgentInbox', { agentId },
    );
    assert.equal(inbox.ok, true);
    assert.equal(inbox.ok && inbox.value.items.length, 1,
      'the durable inbox item vanished when the Run stopped');

    const afterStop = await askAboutRun();
    assert.equal(afterStop.some((item) => item.messageId === sent.value.messageId), true,
      'the Message this shift was sent became invisible to it the moment its Run stopped, '
      + `and the store still holds it: ${JSON.stringify(afterStop)}`);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

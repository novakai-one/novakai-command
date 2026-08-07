// Slice 3 — live lane (R3-1): PTY output becomes messages via messaging's
// PUBLIC contract (MessagingSession.sendMessage) in real time. A fake sender
// standing in for MessagingSession verifies the round-trip; the real session
// satisfies LiveLaneSender structurally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { composeAgents, mockOf } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';
import type { LiveLaneSender } from '../core/live-lane/liveLane.js';

class FakeMessagingSession implements LiveLaneSender {
  readonly sent: unknown[] = [];
  async sendMessage(input: unknown) {
    this.sent.push(input);
    return { kind: 'ok' as const, value: { messageId: 'message_x' } };
  }
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-live-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  const agents = createAgentsContract(ctx);
  const def = await agents.defineAgent(
    { displayName: 'Talker', provider: 'mock', model: 'mock-1', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) throw new Error('setup failed');
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) throw new Error('setup failed');
  return { ctx, agents, sessionId: spawn.value.sessionId };
}

test('live lane: PTY output arrives as a messaging sendMessage in real time', async () => {
  const { ctx, agents, sessionId } = await setup();
  const messaging = new FakeMessagingSession();
  agents.attachLiveLane({ sessionId, address: 'thread:thread_abc', sender: messaging });
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'Chris, the reply is 42' });
  assert.equal(messaging.sent.length, 1);
  const msg = messaging.sent[0] as { address: string; body: { text: string }; priority: string; clientMessageId: string };
  assert.equal(msg.address, 'thread:thread_abc');
  assert.equal(msg.body.text, 'Chris, the reply is 42');
  assert.equal(msg.priority, 'normal');
  assert.match(msg.clientMessageId, /^c_/);
});

test('live lane round-trip: input via send reaches the PTY, output reaches messaging', async () => {
  const { ctx, agents, sessionId } = await setup();
  const messaging = new FakeMessagingSession();
  agents.attachLiveLane({ sessionId, address: 'thread:thread_abc', sender: messaging });
  const mock = mockOf(ctx);
  assert.ok(mock);
  // human → PTY
  assert.equal(mock.send(sessionId, 'what is the answer?\n'), true);
  assert.deepEqual(mock.__session(sessionId)?.sent, ['what is the answer?\n']);
  // PTY → human (in-app message)
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: '42' });
  assert.equal((messaging.sent[0] as { body: { text: string } }).body.text, '42');
});

test('unsubscribing the live lane stops the flow; non-output events never message', async () => {
  const { ctx, agents, sessionId } = await setup();
  const messaging = new FakeMessagingSession();
  const unsub = agents.attachLiveLane({ sessionId, address: 'thread:thread_abc', sender: messaging });
  const mock = mockOf(ctx);
  assert.ok(mock);
  mock.__emit(sessionId, { type: 'activity', sessionId, at: new Date().toISOString(), activity: 'thinking' });
  assert.equal(messaging.sent.length, 0);
  unsub();
  mock.__emit(sessionId, { type: 'output', sessionId, at: new Date().toISOString(), data: 'late' });
  assert.equal(messaging.sent.length, 0);
});

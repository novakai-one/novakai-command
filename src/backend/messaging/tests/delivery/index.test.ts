// Delivery adapter seam tests (messaging rework task 3). N3 deleted the
// router's room arms; their tests went with them. Run with
// `npx tsx src/backend/messaging/tests/delivery/index.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyDelivery } from '../../delivery/index.js';
import { MessageRouter } from '../../router/index.js';
import { MessageStore } from '../../store/index.js';
import type { AgentAddress, MessageEnvelope } from '../../types.js';

const roster: AgentAddress[] = [
  { agentId: 'agent_1', name: 'claude-1', provider: 'claude' },
  { agentId: 'agent_2', name: 'codex-1', provider: 'codex' },
  { agentId: 'agent_3', name: 'codex-2', provider: 'codex' },
];

const writes: Array<{ agentId: string; data: string }> = [];

/** codex-2's PTY is dead — its write reports failure like a vanished terminal. */
function fakeWrite(agentId: string, data: string): boolean {
  if (agentId === 'agent_3') return false;
  writes.push({ agentId, data });
  return true;
}

function envelope(recipient: string, from = 'claude-1'): MessageEnvelope {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    from,
    'to': recipient,
    delivery: 'normal',
    body: 'hello',
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
}

function makeRouter(): { router: MessageRouter; store: MessageStore } {
  const root = mkdtempSync(join(tmpdir(), 'nvk-delivery-'));
  const store = new MessageStore(join(root, 'messages.jsonl'));
  const timings = { interruptSettleMs: 0, submitDelayMs: 0 };
  const router = new MessageRouter(store, new PtyDelivery({ write: fakeWrite }, timings), () => roster);
  return { router, store };
}

async function testMailboxDirectMessages(): Promise<void> {
  const { router, store } = makeRouter();
  writes.length = 0;
  for (const recipient of ['chris', 'kimi']) {
    const receipt = await router.route(envelope(recipient));
    assert.equal(receipt.mode, 'mailbox');
  }
  assert.equal(writes.length, 0, 'nothing is typed for durable mailbox identities');
  assert.ok(store.history().every((message) => message.status === 'queued'),
    'mailbox sends honestly stay queued — the record IS the delivery (R1)');
}

async function testAgentDirectAndUnknown(): Promise<void> {
  const { router, store } = makeRouter();
  writes.length = 0;
  const receipt = await router.route(envelope('codex-1'));
  assert.equal(receipt.mode, 'normal-accepted', 'agent sends return on acceptance (D1 honesty)');
  assert.equal(writes[0]?.agentId, 'agent_2', 'agents still get PTY typing through the seam');
  const missing = envelope('nobody');
  await assert.rejects(() => router.route(missing), /not a live agent/);
  assert.equal(store.history({ limit: 1 })[0]?.status, 'failed', 'unknown recipient fails honestly');
}

await testMailboxDirectMessages();
await testAgentDirectAndUnknown();
console.log('PASS');

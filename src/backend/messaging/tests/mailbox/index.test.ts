// Durable mailbox identity integration tests. Exercises the real HTTP read
// interfaces and the SendApi seam (N2 deleted the agent-originated
// POST /api/messages route the sends used to ride) while keeping mailbox
// identity distinct from live Presence.
// Run with `npx tsx src/backend/messaging/tests/mailbox/index.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MailboxRegistry, MessagingHub } from '../../index.js';
import type { AgentInfo } from '../../../terminal/manager.js';

const agents: AgentInfo[] = [
  {
    agentId: 'agent_1',
    title: 'codex-1',
    provider: 'codex',
    sessionId: 'session_1',
    projectDir: 'project',
    cwd: '/tmp/project',
    status: 'running',
    createdAt: new Date().toISOString(),
  },
];
const writes: Array<{ agentId: string; data: string }> = [];
const root = mkdtempSync(join(tmpdir(), 'nvk-mailbox-'));
const messagingHub = new MessagingHub(
  {
    list: () => agents,
    write: (agentId, data) => {
      writes.push({ agentId, data });
      return true;
    },
  },
  () => {},
  {
    storePath: join(root, 'messages.jsonl'),
    roomsStorePath: join(root, 'rooms.jsonl'),
    mailboxRegistry: MailboxRegistry.inMemory(),
    timings: { interruptSettleMs: 0, submitDelayMs: 0 },
    // Fake sessionIds — the real transcript confirmer would poll for files
    // that never exist. null disables confirmation; sends note it honestly.
    effectConfirmer: null,
  },
);
const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function history(name: string): Promise<any[]> {
  const response = await fetch(`${baseUrl}/api/messages?withAgent=${encodeURIComponent(name)}`);
  return (await response.json()).messages;
}

async function testWorkerCanDeliverToKimiMailbox(): Promise<void> {
  writes.length = 0;
  const envelope = await messagingHub.send.send('codex-1', { 'to': 'kimi', delivery: 'normal', body: 'done' });
  assert.equal(envelope.status, 'queued', 'mailbox honesty: the record IS the delivery (R1)');
  assert.equal(writes.length, 0, 'mailbox delivery writes no PTY bytes');
  assert.equal((await history('kimi')).at(-1)?.body, 'done');
}

async function testKimiCanDeliverToLiveWorker(): Promise<void> {
  writes.length = 0;
  await messagingHub.send.send('kimi', { 'to': 'codex-1', delivery: 'normal', body: 'next mission' });
  assert.equal(writes[0]?.agentId, 'agent_1');
  assert.match(writes[0]?.data ?? '', /^\[nvk-msg from kimi id msg_[^\]]+\] next mission$/);
}

async function testAddressBookSeparatesMailboxAndPresence(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/messaging/address-book`);
  assert.equal(response.status, 200);
  const book = await response.json() as {
    mailboxes: Array<{ memberName: string }>;
    presences: Array<{ name: string }>;
  };
  assert.deepEqual(book.mailboxes.map((entry) => entry.memberName), ['chris', 'kimi']);
  assert.deepEqual(book.presences.map((entry) => entry.name), ['codex-1']);
  assert.ok(!book.presences.some((entry) => entry.name === 'kimi'));
}

async function postMailbox(body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/api/mailboxes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function testRegisterMailboxApi(): Promise<void> {
  const created = await postMailbox({ displayName: 'Manager K3', memberName: 'manager-k3' });
  assert.equal(created.status, 201);
  assert.equal(created.json.identity.memberName, 'manager-k3');
  const conflict = await postMailbox({ displayName: 'Twin', memberName: 'manager-k3' });
  assert.equal(conflict.status, 409);
  const invalid = await postMailbox({ displayName: '', memberName: 'x' });
  assert.equal(invalid.status, 400);
}

async function testRegisteredMailboxRoutes(): Promise<void> {
  // The registered mailbox routes like the seeds: delivery is the log record.
  await messagingHub.send.send('codex-1', { 'to': 'manager-k3', delivery: 'normal', body: 'brief ready' });
  assert.equal((await history('manager-k3')).at(-1)?.body, 'brief ready');
  const book = await (await fetch(`${baseUrl}/api/messaging/address-book`)).json();
  assert.ok(book.mailboxes.some((entry: { memberName: string }) => entry.memberName === 'manager-k3'));
}

try {
  await testWorkerCanDeliverToKimiMailbox();
  await testKimiCanDeliverToLiveWorker();
  await testAddressBookSeparatesMailboxAndPresence();
  await testRegisterMailboxApi();
  await testRegisteredMailboxRoutes();
  console.log('PASS');
} finally {
  server.close();
}

// Durable mailbox identity integration tests — the N4 sliver: the
// registration ROUTE survives (scripts + ExternalSessions depend on it);
// mailbox envelope routing died with the router, and the old address-book
// is gone (agents use the v2 address-book). The registry's own behavior is
// covered by messaging/mailbox/mailbox.test.ts. Run with
// `npx tsx src/backend/messaging/tests/mailbox/index.test.ts`.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import express from 'express';
import { MailboxRegistry, MessagingHub } from '../../index.js';

const messagingHub = new MessagingHub({ mailboxRegistry: MailboxRegistry.inMemory() });
const application = express();
application.use(express.json());
messagingHub.registerRoutes(application);
const server: Server = await new Promise((resolve) => {
  const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
});
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

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
  const addressBook = await fetch(`${baseUrl}/api/messaging/address-book`);
  assert.equal(addressBook.status, 404, 'the old address-book route is deleted (N4)');
}

try {
  await testRegisterMailboxApi();
  console.log('PASS');
} finally {
  server.close();
}

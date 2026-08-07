// What a cutover is FOR — §18.1, §8.1, §25-B3c.
//
// Exam row J4: "a Message committed before the cutover is still present and
// readable through the canonical route afterwards" —
// `{"migratedMessages":0,"publicItems":5}`. J2, J3, J5 and J6 all pass around
// it: the receipt is sealed, the fence holds, the legacy file does not grow,
// and a route conflict blocks boot. The one thing nothing checked is whether
// anybody can READ what was migrated.
//
// `b3c-boot-cutover.test.ts` counts canonical lines and inspects the receipt —
// both facts about files. This asks the only question a person has: after the
// route moved, is my conversation still there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { LEGACY_MESSAGING_STORE } from '../core/b3/cutover-report.js';

/** The Agent the legacy conversation was with. Any id: it is a pre-existing fact. */
const AGENT_ID = 'agent_11111111-1111-4111-8111-111111111111';
const AGENT_PERSON = `person_agent-${AGENT_ID.slice('agent_'.length)}`;
const THREAD_ID = 'thread_legacy0000000000000000000000';

/**
 * One legacy `messaging.jsonl` line — a bare StoreOp in the historic acceptance
 * shape, with the singleton `journal` §8.1 requires be normalised rather than
 * refused. This is a conversation between Chris and an Agent, because that is
 * what a B3c root actually contains.
 */
function legacyAcceptance(ordinal: number): string {
  const messageId = `message_${String(ordinal).padStart(32, '0')}`;
  return JSON.stringify({
    op: 'acceptance',
    thread: {
      id: THREAD_ID, kind: 'thread', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', threadKind: 'direct',
      direct: { pair: ['person_chris', AGENT_PERSON] },
    },
    acceptance: {
      id: `acceptance_${String(ordinal)}`, kind: 'acceptance', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      senderId: 'person_chris',
      clientMessageId: `cmid-${String(ordinal)}`,
      requestHash: `hash-${String(ordinal)}`,
      messageId,
    },
    message: {
      id: messageId, kind: 'message', schemaVersion: 1,
      createdAt: `2026-01-01T00:00:0${String(ordinal)}.000Z`,
      threadId: THREAD_ID,
      senderId: 'person_chris',
      clientMessageId: `cmid-${String(ordinal)}`,
      sequence: ordinal, priority: 'normal',
      body: { text: `written before the cutover ${String(ordinal)}` },
    },
    snapshot: {
      id: `snapshot_${String(ordinal)}`, kind: 'recipient-snapshot', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', messageId, recipients: [AGENT_PERSON],
    },
    deliveries: [{
      id: `delivery_${String(ordinal)}`, kind: 'delivery', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      messageId, threadId: THREAD_ID,
      recipientId: AGENT_PERSON, state: 'pending',
    }],
    journal: {
      sequence: ordinal, kind: 'accepted', messageId,
      at: '2026-01-01T00:00:00.000Z',
    },
  });
}

test('every Message migrated by the cutover is readable through the canonical route',
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-cutover-read-'));
    const ordinals = [1, 2, 3, 4, 5];
    writeFileSync(
      path.join(root, LEGACY_MESSAGING_STORE),
      `${ordinals.map(legacyAcceptance).join('\n')}\n`, 'utf8',
    );
    const host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const chris = await connectRuntime({ root, port: host.port, token: host.token });
    try {
      // The file half — the half `b3c-boot-cutover.test.ts` already proves, kept
      // here so a failure below cannot be blamed on a cutover that never ran.
      const canonical = readFileSync(
        path.join(root, 'stores', 'messagingStoreOps.jsonl'), 'utf8',
      ).split('\n').filter((line) => line !== '');
      assert.equal(canonical.length >= ordinals.length, true,
        `${String(canonical.length)} canonical operations for ${String(ordinals.length)} legacy lines`);

      // The half nobody checked. A client that knows nothing about either route
      // asks §19.2's question and must see the conversation it had yesterday.
      const seen = await chris.call<{ items: readonly { messageId: string; textPreview: string }[] }>(
        'b3.messaging.listAgentCommunications', { agentIds: [AGENT_ID] },
      );
      assert.equal(seen.ok, true, seen.ok ? '' : `${seen.error.code}: ${seen.error.message}`);
      if (!seen.ok) return;

      const migrated = ordinals.filter((ordinal) => seen.value.items.some(
        (item) => item.messageId === `message_${String(ordinal).padStart(32, '0')}`));
      assert.deepEqual(migrated, ordinals,
        `${String(migrated.length)} of ${String(ordinals.length)} pre-cutover Messages are `
        + `readable through the canonical route (${String(seen.value.items.length)} row(s) returned)`);
    } finally {
      chris.close();
      await host.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

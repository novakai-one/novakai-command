/**
 * messagingV2 capability-journal reader tests (slice N5, D-N5-4): the
 * acceptance-op fold (envelope shape + last-activity-per-senderId), torn
 * line tolerance, missing-file emptiness, and the env-override default
 * path. Run with `npx tsx src/backend/messagingV2/journal/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultCapabilityJournalPath,
  lastActivityBySenderId,
  readJournalEnvelopes,
} from './index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nvk-mv2-journal-'));
const journalPath = path.join(scratch, 'journal.jsonl');

const acceptance = (id: string, senderId: string, threadId: string, createdAt: string, priority = 'normal') =>
  JSON.stringify({
    'op': 'acceptance',
    thread: { id: threadId, kind: 'thread', schemaVersion: 1, createdAt, threadKind: 'direct' },
    message: {
      id, kind: 'message', schemaVersion: 1, createdAt, threadId,
      senderId, clientMessageId: `cm-${id}`, sequence: 1, priority, body: { text: `body of ${id}` },
    },
  });

writeFileSync(journalPath, [
  '{"op":"room-thread","thread":{"id":"thread_x"}}',                     // not an acceptance — skipped
  acceptance('message_1', 'person_agent-a', 'thread_dm', '2026-07-25T10:00:00.000Z'),
  '{ torn line',
  acceptance('message_2', 'person_agent-a', 'thread_dm', '2026-07-25T11:00:00.000Z'),
  acceptance('message_3', 'person_user-chris', 'thread_fleet', '2026-07-25T10:30:00.000Z', 'urgent'),
  acceptance('message_bad', 'person_agent-a', 'thread_dm', 'not-a-date'), // bad createdAt — skipped
].join('\n') + '\n');

const envelopes = readJournalEnvelopes(journalPath);
assert.equal(envelopes.length, 3, 'only well-formed acceptance ops fold');
assert.deepEqual(envelopes[0], {
  id: 'message_1',
  from: 'person_agent-a',
  'to': 'thread_dm',
  delivery: 'normal',
  body: 'body of message_1',
  threadId: 'thread_dm',
  createdAt: '2026-07-25T10:00:00.000Z',
  status: 'delivered',
});
assert.equal(envelopes[2]?.delivery, 'interrupt', 'urgent priority maps to interrupt');
console.log('envelope fold tests passed');

const activity = lastActivityBySenderId(journalPath);
assert.equal(activity.get('person_agent-a'), Date.parse('2026-07-25T11:00:00.000Z'), 'last activity is the NEWEST stamp');
assert.equal(activity.get('person_user-chris'), Date.parse('2026-07-25T10:30:00.000Z'));
assert.equal(activity.get('person_agent-ghost'), undefined);
console.log('last-activity tests passed');

assert.deepEqual(readJournalEnvelopes(path.join(scratch, 'missing.jsonl')), [], 'a missing file is an empty fold, never a crash');
assert.equal(lastActivityBySenderId(path.join(scratch, 'missing.jsonl')).size, 0);
console.log('missing-file tests passed');

{
  const prior = process.env.NVK_MESSAGING_V2_STORE;
  delete process.env.NVK_MESSAGING_V2_STORE;
  assert.ok(defaultCapabilityJournalPath().endsWith(path.join('.novakai-command', 'messaging-v2', 'journal.jsonl')));
  process.env.NVK_MESSAGING_V2_STORE = '/tmp/pinned-journal.jsonl';
  assert.equal(defaultCapabilityJournalPath(), '/tmp/pinned-journal.jsonl', 'NVK_MESSAGING_V2_STORE wins');
  if (prior === undefined) delete process.env.NVK_MESSAGING_V2_STORE;
  else process.env.NVK_MESSAGING_V2_STORE = prior;
  console.log('default path tests passed');
}

console.log('capability journal reader tests passed');

/**
 * messagingV2 frontend data plane — translator + fold unit tests (slice
 * N4, D-N4-2): lane derivation, message translation, the honesty table
 * (committed → delivered, failed DeliveryUpdated → failed row, queued
 * optimism), sequence dedupe, cursor persistence, conversations + amber.
 * Pure functions only (the hook is thin React). Run with
 * `npx tsx src/frontend/lib/messagingV2/index.test.ts`.
 */
import assert from 'node:assert/strict';
import {
  advanceCursor,
  applyDelivery,
  buildConversations,
  formatRoute,
  laneForThread,
  latestChrisQuestion,
  loadCursor,
  messagesFor,
  nameForPersonId,
  saveCursor,
  translateMessage,
  upsertRow,
  HUMAN_PERSON_ID,
} from './index.js';
import type { CapabilityMessage, CapabilityThread, MessageRow } from './index.js';

const agents = [
  { agentId: 'agent_alice', title: 'chief-kimi', provider: 'kimi' as const, status: 'running' as const },
  { agentId: 'agent_bob', title: 'worker-b', provider: 'claude' as const, status: 'running' as const },
];
const ALICE_PERSON = 'person_agent-alice';

const directThread: CapabilityThread = {
  id: 'thread_dm', threadKind: 'direct', direct: { pair: [HUMAN_PERSON_ID, ALICE_PERSON] },
};
const fleetThread: CapabilityThread = { id: 'thread_fleet', threadKind: 'team', label: '#team' };
const crewThread: CapabilityThread = { id: 'thread_crew', threadKind: 'team', label: '#Messaging Crew' };
const threads = new Map([
  ['thread_dm', directThread],
  ['thread_fleet', fleetThread],
  ['thread_crew', crewThread],
]);

function message(overrides: Partial<CapabilityMessage>): CapabilityMessage {
  return {
    id: 'message_1', threadId: 'thread_dm', senderId: HUMAN_PERSON_ID,
    sequence: 1, priority: 'normal', createdAt: '2026-07-22T10:00:00.000Z',
    body: { text: 'hello' },
    ...overrides,
  };
}

// --- name + lane derivation ----------------------------------------------------

assert.equal(nameForPersonId(HUMAN_PERSON_ID, agents), 'chris');
assert.equal(nameForPersonId(ALICE_PERSON, agents), 'chief-kimi', 'forward derivation to the roster title');
assert.equal(nameForPersonId('person_ghost', agents), 'person_ghost', 'unknown personIds pass through');
assert.equal(laneForThread(directThread, agents), 'dm:chief-kimi', 'direct thread ↔ the other party');
assert.equal(laneForThread(fleetThread, agents), '#team');
assert.equal(laneForThread(crewThread, agents), '#Messaging Crew', 'team room ↔ its directory label');
assert.equal(
  laneForThread({ id: 'thread_x', threadKind: 'mission', room: { authority: 'mission', externalId: 'mission_alpha' } }, agents),
  '#mission_alpha',
  'an unlabeled room falls back to its externalId',
);
console.log('name + lane derivation tests passed');

// --- message translation ---------------------------------------------------------

const translated = translateMessage(message({}), threads, agents);
assert.deepEqual(translated, {
  id: 'message_1',
  from: 'chris',
  'to': 'dm:chief-kimi',
  delivery: 'normal',
  body: 'hello',
  threadId: 'thread_dm',
  createdAt: '2026-07-22T10:00:00.000Z',
  status: 'delivered',
}, 'a committed message IS durable truth — quiet delivered');
assert.equal(
  translateMessage(message({ priority: 'urgent' }), threads, agents).delivery,
  'interrupt',
  'urgent priority renders as interrupt delivery',
);
assert.equal(formatRoute(translated), 'chris → chief-kimi', 'the dm lane renders its agent name in routes');
// F3 (audit): an INCOMING dm row (from === the lane name) renders its bare
// sender — never '<name> → <name>'; outgoing keeps the route.
const incoming = translateMessage(message({ senderId: ALICE_PERSON }), threads, agents);
assert.equal(incoming.from, 'chief-kimi');
assert.equal(formatRoute(incoming), 'chief-kimi', 'incoming dm rows render the bare sender');
assert.equal(formatRoute(translated), 'chris → chief-kimi', 'outgoing keeps the full route');
console.log('message translation tests passed');

// --- the honesty table -------------------------------------------------------------

const optimistic = upsertRow([], { ...translated, id: 'local_1', status: 'queued' });
const confirmed = optimistic.map((entry) => (entry.id === 'local_1' ? { ...entry, id: translated.id } : entry));
const settledRows = upsertRow(confirmed, { ...translated, status: 'delivered' });
assert.equal(settledRows.length, 1, 'the 201 rename + committed echo fold the queued row in place');
assert.equal(settledRows[0]?.status, 'delivered');

const failed = applyDelivery([translated], { messageId: 'message_1', state: 'failed' });
assert.equal(failed[0]?.status, 'failed', 'a failed DeliveryUpdated marks its row');
const quiet = applyDelivery([translated], { messageId: 'message_1', state: 'pending' });
assert.equal(quiet[0]?.status, 'delivered', 'pending/delivered states never touch rows (no invented failure)');
const unknownDelivery = applyDelivery([translated], { messageId: 'message_ghost', state: 'failed' });
assert.equal(unknownDelivery.length, 1, 'a delivery for an unknown message is a no-op');
console.log('honesty table tests passed');

// --- sequence dedupe + cursor -------------------------------------------------------

assert.equal(advanceCursor(10, 12), 12);
assert.equal(advanceCursor(12, 12), 12, 'at/below the cursor is a dupe');
assert.equal(advanceCursor(12, 9), 12);
assert.equal(advanceCursor(12, undefined), 12, 'unsequenced frames never move the cursor');

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (storeKey: string) => store.get(storeKey) ?? null,
  setItem: (storeKey: string, value: string) => void store.set(storeKey, value),
};
saveCursor(42);
assert.equal(loadCursor(), 's_42', 'the resume cursor persists across reloads');
console.log('dedupe + cursor tests passed');

// --- conversations + amber -----------------------------------------------------------

const feed: MessageRow[] = [
  { ...translated, id: 'm1', 'to': 'dm:chief-kimi', from: 'chief-kimi', body: 'hey chris, look', createdAt: '2026-07-22T10:01:00.000Z' },
  { ...translated, id: 'm2', 'to': '#team', from: 'worker-b', body: 'status green', createdAt: '2026-07-22T10:02:00.000Z' },
];
const conversations = buildConversations([directThread, fleetThread], feed, agents);
assert.ok(conversations.some((lane) => lane.id === '#team' && lane.kind === 'channel'));
assert.ok(conversations.some((lane) => lane.id === 'dm:chief-kimi' && lane.kind === 'dm'));
assert.ok(conversations.some((lane) => lane.id === 'dm:worker-b', ), 'a silent agent still gets an openable lane');
assert.equal(conversations[0]?.id, '#team', 'recency sorts the freshest lane first');

const amber = latestChrisQuestion(feed);
assert.equal(amber?.conversationId, 'dm:chief-kimi', 'the amber grammar works over translated rows');
assert.equal(messagesFor(feed, 'dm:chief-kimi').length, 1);
assert.equal(messagesFor(feed, '#team').length, 1);
console.log('conversations + amber tests passed');

console.log('messagingV2 data plane tests passed');

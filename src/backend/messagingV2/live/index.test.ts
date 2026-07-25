/**
 * messagingV2 live dialect tests (slice N4, D-N4-1): a per-connection
 * `{type:'messaging-v2-sub'}` frame creates a human-session subscription
 * whose frames land on THAT socket verbatim; the cursor resume skips
 * already-seen history; a dead socket ends the subscription (permanent
 * sink failure); close() is the manual teardown. Real embedded stack over a
 * memory store; fake socket. Run with
 * `npx tsx src/backend/messagingV2/live/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../../../packages/messaging/adapters/store-memory.js';
import { createSystemClock } from '../../../../packages/messaging/adapters/clock-system.js';
import { createEmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import { createMessagingLive } from './index.js';
import type { LiveSocket } from './index.js';

class FakeSocket implements LiveSocket {
  readonly sent: string[] = [];
  readyState = 1;
  send(data: string): void { this.sent.push(data); }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((data) => (JSON.parse(data) as { payload: Record<string, unknown> }).payload);
  }
}

const clock = createSystemClock();
const embedded = createEmbeddedMessaging({
  clock,
  store: createMemoryStore(clock),
  authority: {
    principals: [{ token: 'human-secret', personId: 'person_user-chris' as never, roles: ['Human'] }],
    roleGrants: { Human: ['priority.override'] },
  },
});
await embedded.start();

async function humanSession(): Promise<MessagingSession> {
  const auth = await embedded.authenticate({ token: 'human-secret' });
  if (auth.kind !== 'authenticated') throw new Error('unreachable');
  return auth.session;
}

let session = await humanSession();
const live = createMessagingLive({ humanSession: () => session });

async function commit(text: string, clientMessageId: string): Promise<string> {
  const accepted = await session.sendMessage({
    address: 'person:person_user-chris', body: { text },
    priority: 'normal', clientMessageId,
  });
  if (accepted.kind !== 'ok') throw new Error('unreachable');
  // The app tails the bus at 500 ms; this rig pumps manually (the same
  // trigger — event CONTENT is journal-sourced either way).
  await embedded.pumpEvents();
  return accepted.value.messageId;
}

// --- subscribe → started frame, then live commits on THAT socket -------------

const first = new FakeSocket();
await live.subscribe(first, undefined);
assert.equal(live.count, 1);
assert.equal(first.frames()[0]?.['kind'], 'started', 'the subscription announces itself');
const firstMessageId = await commit('hello live', 'live-1');
const committed = first.frames().find((frame) =>
  frame['kind'] === 'event' && (frame['event'] as { message?: { id?: string } }).message?.id === firstMessageId);
assert.ok(committed, 'the MessageCommitted frame landed on the socket verbatim');
assert.equal(typeof committed?.['sequence'], 'number', 'sequenced frames carry the resume cursor data');
console.log('subscribe + live frame tests passed');

// --- cursor resume: history before the cursor is NOT replayed ------------------

const second = new FakeSocket();
await live.subscribe(second, 's_999999');
await commit('after resume', 'live-2');
const replayed = second.frames().filter((frame) =>
  frame['kind'] === 'event' && (frame['event'] as { message?: { id?: string } }).message?.id === firstMessageId);
assert.equal(replayed.length, 0, 'commits at/below the cursor are not replayed');
assert.ok(
  second.frames().some((frame) =>
    frame['kind'] === 'event'
    && ((frame['event'] as { message?: { body?: { text: string } } }).message?.body?.text) === 'after resume'),
  'new commits still flow after a resumed subscribe',
);
console.log('cursor resume tests passed');

// --- a dead socket ends the subscription (permanent sink failure) --------------

first.readyState = 0; // closed mid-stream
const sentBefore = first.sent.length;
await commit('nobody home', 'live-3');
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(first.sent.length, sentBefore, 'nothing is written into a dead socket');
console.log('dead-socket teardown test passed');

// --- close() is the manual teardown ----------------------------------------------

live.close(first); // the production teardown path: the server's socket-close handler
live.close(second);
assert.equal(live.count, 0, 'close drops the per-connection handles');
const secondBefore = second.sent.length;
await commit('post teardown', 'live-4');
await new Promise((resolve) => setTimeout(resolve, 30));
assert.equal(second.sent.length, secondBefore, 'a torn-down subscription forwards nothing');
console.log('manual teardown tests passed');

// --- no human session → honest dependency-lost frame ------------------------------

session = null as never;
const third = new FakeSocket();
const liveWithoutHuman = createMessagingLive({ humanSession: () => null });
await liveWithoutHuman.subscribe(third, undefined);
assert.equal(liveWithoutHuman.count, 0);
assert.deepEqual(third.frames()[0], { kind: 'ended', subscriptionId: 'unavailable', reason: 'dependency-lost' });
console.log('dependency-lost honesty test passed');

await embedded.close();
console.log('messagingV2 live dialect tests passed');

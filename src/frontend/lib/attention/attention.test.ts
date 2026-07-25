import assert from 'node:assert/strict';
import {
  AttentionEngine,
  approvalItem,
  buildAttentionQueue,
  failedMessageItems,
  messageItemId,
  type AttentionItem,
} from './index.js';
import type { TunnelEnvelope } from '../messagingV2/index.js';
import type { ThreadProjection } from '../../../shared/provider/schema.js';

function envelope(overrides: Partial<TunnelEnvelope>): TunnelEnvelope {
  return {
    id: 'msg_1',
    from: 'claude-1',
    'to': 'codex-1',
    delivery: 'normal',
    body: 'ping',
    createdAt: '2026-07-17T09:00:00.000Z',
    status: 'failed',
    ...overrides,
  };
}

function projectionWith(kind: 'approval' | 'assistant'): ThreadProjection {
  return {
    thread: { id: 'thread-1', title: 'T', sessionReferences: [], createdAt: '', updatedAt: '' },
    events: [{
      id: 'e1', provider: 'claude', sessionId: 's1', kind,
      timestamp: '2026-07-17T09:05:00.000Z', text: '', rawType: kind,
      ...(kind === 'approval' ? { approval: { writes: [] } } : {}),
    }],
    issues: [],
  };
}

// ---------------------------------------------------------------- queue
// Only a trailing approval needs Chris; anything newer releases it.
assert.equal(approvalItem(null), null);
assert.equal(approvalItem(projectionWith('assistant')), null);
assert.equal(approvalItem(projectionWith('approval'))?.id, 'approval:e1');
assert.equal(approvalItem(projectionWith('approval'))?.threadId, 'thread-1');

// Failed sends enter the queue until dismissed; delivered/queued never do.
const failures = failedMessageItems(
  [envelope({}), envelope({ id: 'msg_2', status: 'delivered' }), envelope({ id: 'msg_3' })],
  new Set([messageItemId('msg_3')]),
);
assert.deepEqual(failures.map((item) => item.id), ['message:msg_1']);

// Approval outranks failures; failures order oldest-first.
const queue = buildAttentionQueue(
  projectionWith('approval'),
  [envelope({ id: 'msg_b', createdAt: '2026-07-17T09:02:00.000Z' }), envelope({ id: 'msg_a', createdAt: '2026-07-17T09:01:00.000Z' })],
  new Set(),
);
assert.deepEqual(queue.map((item) => item.id), ['approval:e1', 'message:msg_a', 'message:msg_b']);

// ---------------------------------------------------------------- engine
// Fake scheduler: timers fire only when the test says so.
interface FakeTimer { callback: () => void; delayMs: number; cancelled: boolean }
const timers: FakeTimer[] = [];
const engine = new AttentionEngine((callback, delayMs) => {
  const timer: FakeTimer = { callback, delayMs, cancelled: false };
  timers.push(timer);
  return () => { timer.cancelled = true; };
});
function fireNext(): FakeTimer {
  const timer = timers.shift();
  assert.ok(timer && !timer.cancelled);
  timer.callback();
  return timer;
}

const itemA: AttentionItem = { id: 'message:a', kind: 'failed-message', threadId: 't1', since: '1' };
const itemB: AttentionItem = { id: 'message:b', kind: 'failed-message', threadId: null, since: '2' };

// The head takes gold; the second item stays monochrome.
engine.update([itemA, itemB]);
assert.equal(engine.getSnapshot().goldId, 'message:a');
assert.equal(engine.getSnapshot().goldThreadId, 't1');
assert.equal(engine.getSnapshot().settlingId, null);

// Re-updating with the gold still present never re-triggers anything.
engine.update([itemA, itemB]);
assert.equal(engine.getSnapshot().goldId, 'message:a');
assert.equal(timers.length, 0);

// Resolving the gold: it settles to sage; B does NOT take gold instantly.
engine.update([itemB]);
assert.equal(engine.getSnapshot().goldId, null);
assert.equal(engine.getSnapshot().settlingId, 'message:a');

// After the settle window the sage clears — still no gold (the beat).
assert.equal(fireNext().delayMs, 900);
assert.equal(engine.getSnapshot().settlingId, null);
assert.equal(engine.getSnapshot().goldId, null);

// Only after the beat does the next item take the gold.
assert.equal(fireNext().delayMs, 500);
assert.equal(engine.getSnapshot().goldId, 'message:b');

// Resolving the last item leaves the screen fully calm.
engine.update([]);
assert.equal(engine.getSnapshot().settlingId, 'message:b');
fireNext();
fireNext();
assert.deepEqual(engine.getSnapshot(), { goldId: null, goldThreadId: null, settlingId: null, settlingThreadId: null });

// An item arriving mid-beat waits for the beat to end.
engine.update([itemA]);
assert.equal(engine.getSnapshot().goldId, 'message:a');
engine.update([]);
fireNext(); // settle ends
engine.update([itemB]); // arrives during the beat
assert.equal(engine.getSnapshot().goldId, null);
fireNext(); // beat ends
assert.equal(engine.getSnapshot().goldId, 'message:b');

console.log('attention: all assertions passed');

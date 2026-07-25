/**
 * messagingV2 feed lib — audit regression tests (F1/F4/F5/F7/F8a/F12/F16).
 * Module-level seams only ( the hook itself stays thin React). Run with
 * `npx tsx src/frontend/lib/messagingV2/feed/index.test.ts`.
 */
import assert from 'node:assert/strict';

// Fake WebSocket BEFORE agentSocket loads (F1's already-connected socket).
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public targetUrl: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(frame: string): void { this.sent.push(frame); }
  triggerMessage(payload: object): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

const feedModule = await import('./index.js');
const agentSocket = await import('../../agentSocket/index.js');
// Loose test doubles over the module seams (config has no no-explicit-any rule).
const {
  applyFrame,
  frameHandler,
  makeReload,
  makeSend,
  wireLive,
} = feedModule as unknown as {
  applyFrame: (state: any, frame: any, agents: any, setFeed: any, setThreads: any) => void;
  frameHandler: (...args: any[]) => (frame: any) => void;
  makeReload: (...args: any[]) => () => Promise<void>;
  makeSend: (...args: any[]) => (input: { to: string; body: string }) => Promise<boolean>;
  wireLive: (refs: any) => () => void;
};

const AGENTS = [{ agentId: 'agent_alice', title: 'chief-kimi', provider: 'kimi' as const, sessionId: 's', projectDir: 'p', cwd: 'c', status: 'running' as const, createdAt: 'x' }];

const THREAD = { id: 'thread_dm', threadKind: 'direct' as const, direct: { pair: ['person_user-chris', 'person_agent-alice'] as [string, string] } };
const NEW_THREAD = { id: 'thread_new', threadKind: 'team' as const, label: '#New Room' };

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (storeKey: string) => store.get(storeKey) ?? null,
  setItem: (storeKey: string, value: string) => void store.set(storeKey, value),
};

interface FetchRule {
  status?: number;
  body?: unknown;
  fail?: boolean;
}
const fetchLog: string[] = [];
let fetchRules: Record<string, FetchRule> = {};
function installFetch(rules: Record<string, FetchRule>): void {
  fetchRules = rules;
  (globalThis as { fetch?: unknown }).fetch = async (requestUrl: string) => {
    fetchLog.push(String(requestUrl));
    const rule = Object.entries(fetchRules).find(([prefix]) => String(requestUrl).startsWith(prefix))?.[1];
    if (rule === undefined || rule.fail === true) throw new Error('offline');
    if (rule.status !== undefined && rule.status !== 200) return new Response('nope', { status: rule.status });
    return new Response(JSON.stringify(rule.body ?? {}), { status: 200 });
  };
}

function okFetch(): void {
  installFetch({
    '/api/messaging/v2/user/threads': { body: { threads: [THREAD] } },
    '/api/messaging/v2/user/messages': { body: { messages: [] } },
    '/api/messaging/v2/user/send': { body: { messageId: 'message_posted', threadId: 'thread_dm' } },
  });
}

function makeState(): { current: { threads: Map<string, unknown>; lastSeen: number; localCounter: number } } {
  return { current: { threads: new Map([[THREAD.id, THREAD]]), lastSeen: 0, localCounter: 0 } };
}

function captureFeed(): { setFeed: (input: unknown) => void; read: () => unknown[] } {
  let current: unknown[] = [];
  const setFeed = (input: unknown): void => {
    current = typeof input === 'function' ? (input as (rows: unknown[]) => unknown[])(current) : input as unknown[];
  };
  return { setFeed, read: () => current };
}

// --- F1: mount against an ALREADY-connected socket → sub frame, no transition ---

okFetch();
agentSocket.connect();
await new Promise((resolve) => setTimeout(resolve, 20)); // the socket is OPEN before wireLive runs
const wireSocket = FakeSocket.instances.at(-1)!;
wireSocket.sent.length = 0;
{
  const captured = captureFeed();
  wireLive({
    state: makeState(),
    agentsRef: { current: AGENTS },
    setFeed: captured.setFeed,
    setPresence: () => {},
    setConnection: () => {},
    setLoadError: () => {},
    reload: () => Promise.resolve(),
    subscribeLive: () => {
      // post-fix path: wireLive subscribes via this when already connected
      agentSocket.sendMessagingV2Sub('s_0');
    },
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert.ok(
  wireSocket.sent.some((frame) => (JSON.parse(frame) as { type?: string }).type === 'messaging-v2-sub'),
  'an already-connected socket gets the subscribe frame immediately — no transition needed',
);
console.log('F1 subscribe-on-connected test passed');

// --- F4: a failed POST marks the optimistic row 'failed' -------------------------

installFetch({ '/api/messaging/v2/user/send': { fail: true } });
{
  const captured = captureFeed();
  const send = makeSend(makeState(), captured.setFeed) as (input: { to: string; body: string }) => Promise<boolean>;
  const sent = await send({ 'to': 'worker-b', body: 'will fail' });
  assert.equal(sent, false);
  const rows = captured.read() as Array<{ status: string }>;
  assert.equal(rows[0]?.status, 'failed', 'a failed POST is an honest terminal failure, never a ghost queued row');
}
console.log('F4 failed-post row test passed');

// --- F5: dependency-lost before first success → NO reload storm, real backoff ----

{
  let reloadCalls = 0;
  const delays: number[] = [];
  const schedule = (_task: () => void, delayMs: number): void => { delays.push(delayMs); };
  const handler = frameHandler(
    makeState(), { current: AGENTS }, captureFeed().setFeed, () => {},
    () => { reloadCalls += 1; return Promise.resolve(); },
    () => {}, schedule,
  ) as (frame: unknown) => void;
  for (let count = 0; count < 3; count += 1) handler({ kind: 'ended', reason: 'dependency-lost' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(reloadCalls, 0, 'dependency-lost before the first success never refetches');
  assert.ok(delays.length > 0, 'a retry IS scheduled');
  assert.ok(delays.every((delay, index) => index === 0 || delay > (delays[index - 1] ?? 0)), `backoff grows (${JSON.stringify(delays)})`);
}
console.log('F5 dependency-lost backoff tests passed');

// --- F7: reload folds history UNDER live rows (live wins), never wholesale --------

okFetch();
{
  const liveOnly = { id: 'message_live', from: 'chief-kimi', 'to': 'dm:chief-kimi', delivery: 'normal', body: 'live', createdAt: 'T', status: 'delivered' };
  const stale = { id: 'message_1', from: 'chris', 'to': 'dm:chief-kimi', delivery: 'normal', body: 'same', createdAt: 'T', status: 'queued' };
  const current: unknown[] = [liveOnly, stale];
  const reload = makeReload(
    makeState(), { current: AGENTS },
    (input: unknown) => {
      const merged = typeof input === 'function' ? (input as (rows: unknown[]) => unknown[])(current) : input;
      const rows = merged as Array<{ id: string; status: string }>;
      assert.ok(rows.some((entry) => entry.id === 'message_live'), 'a live frame landing mid-reload SURVIVES');
      assert.equal(rows.find((entry) => entry.id === 'message_1')?.status, 'queued', 'live wins per id over history');
    },
    () => {}, () => {}, () => {},
  ) as () => Promise<void>;
  await reload();
}
console.log('F7 reload merge test passed');

// --- F8a: a DeliveryUpdated sequence advances the cursor ----------------------------

{
  const state = makeState();
  applyFrame(state.current, {
    kind: 'event', sequence: 42,
    event: { delivery: { messageId: 'message_1', state: 'failed' }, sequence: 42 },
  } as never, AGENTS, captureFeed().setFeed, () => {});
  assert.equal(state.current.lastSeen, 42, 'delivery sequences advance the cursor — replay can never skip them');
  assert.equal(store.get('nvk-messaging-v2-cursor'), 's_42', 'the cursor persists');
}
console.log('F8a delivery cursor test passed');

// --- F12: a frame for an unknown thread refetches threads, then lands in the lane ---

installFetch({
  '/api/messaging/v2/user/threads': { body: { threads: [THREAD, NEW_THREAD] } },
  '/api/messaging/v2/user/messages': { body: { messages: [] } },
});
{
  fetchLog.length = 0;
  const captured = captureFeed();
  const state = makeState();
  applyFrame(state.current, {
    kind: 'event', sequence: 7,
    event: {
      message: {
        id: 'message_new', threadId: 'thread_new', senderId: 'person_user-chris',
        sequence: 7, priority: 'normal', createdAt: 'T', body: { text: 'new room post' },
      },
      sequence: 7,
    },
  } as never, AGENTS, captured.setFeed, () => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(
    fetchLog.some((requestUrl) => requestUrl.includes('/api/messaging/v2/user/threads')),
    'an unknown threadId triggers a threads refetch',
  );
  const rows = captured.read() as Array<{ to: string }>;
  assert.equal(rows[0]?.to, '#New Room', 'the frame lands in the resolved lane, never a raw threadId lane');
}
console.log('F12 unknown-thread refetch test passed');

// --- F16: a failed load is a load error, never a fake empty inbox ---------------------

{
  installFetch({ '/api/messaging/v2/user/': { fail: true } });
  const errors: boolean[] = [];
  const reload = makeReload(makeState(), { current: AGENTS }, () => {}, () => {}, () => {}, (flag: boolean) => errors.push(flag)) as () => Promise<void>;
  await reload();
  assert.deepEqual(errors, [true], 'a failed load reports the error state');
  okFetch();
  await reload();
  assert.deepEqual(errors, [true, false], 'a successful load clears it');
}
console.log('F16 load-error state tests passed');

console.log('messagingV2 feed audit tests passed');

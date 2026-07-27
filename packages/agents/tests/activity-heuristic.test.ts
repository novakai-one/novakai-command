// S2b — presence activity for REAL sessions (DEC-S2-15, §22 ruling 12).
// The terminal adapter derives heuristic activity from PTY output: a chunk →
// an activity signal, coalesced to at most ONE per window per session; a
// quiet window with no output → idle. No flicker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PtyEvent } from '../contract/schemas.js';
import { createTerminalAdapter } from '../core/providers/terminal.js';
import type { TerminalRuntimeLike } from '../core/providers/adapter.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeRuntime() {
  const dataHandlers: Array<(agentId: string, data: string) => void> = [];
  const exitHandlers: Array<(agentId: string, code: number | null) => void> = [];
  const live = new Map<string, { status: 'running' | 'exited' }>();
  const runtime: TerminalRuntimeLike = {
    async create(opts) {
      const key = opts.agentId ?? 'unknown';
      live.set(key, { status: 'running' });
      return { agentId: key, status: 'running', terminalPid: 4242 };
    },
    write: () => true,
    kill(agentId) { live.delete(agentId); return true; },
    list() { return [...live.entries()].map(([agentId, s]) => ({ agentId, status: s.status })); },
    onData(cb) { dataHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
  };
  return {
    runtime,
    emitData: (key: string, data: string) => dataHandlers.forEach((h) => h(key, data)),
    emitExit: (key: string, code: number | null) => exitHandlers.forEach((h) => h(key, code)),
  };
}

test('output burst coalesces to at most one activity event per window', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' }, { activityIntervalMs: 100, idleMs: 1000 });
  const s = await adapter.spawn('agent_a', 'kimi', {});
  const events: PtyEvent[] = [];
  adapter.subscribe(s.sessionId, (e) => events.push(e));

  for (let i = 0; i < 20; i += 1) host.emitData(s.sessionId, `chunk ${i}`);
  const activity = events.filter((e) => e.type === 'activity' && e.activity !== 'idle');
  assert.equal(activity.length, 1, '20 chunks inside one window → 1 activity event');
});

test('a second burst after the window emits again (still ≤1 per window)', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' }, { activityIntervalMs: 80, idleMs: 1000 });
  const s = await adapter.spawn('agent_a', 'kimi', {});
  const events: PtyEvent[] = [];
  adapter.subscribe(s.sessionId, (e) => events.push(e));

  host.emitData(s.sessionId, 'burst 1');
  await sleep(120); // window passes
  host.emitData(s.sessionId, 'burst 2');
  const activity = events.filter((e) => e.type === 'activity' && e.activity !== 'idle');
  assert.equal(activity.length, 2);
});

test('quiet window → idle event; new output after idle wakes activity again', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' }, { activityIntervalMs: 60, idleMs: 120 });
  const s = await adapter.spawn('agent_a', 'kimi', {});
  const events: PtyEvent[] = [];
  adapter.subscribe(s.sessionId, (e) => events.push(e));

  host.emitData(s.sessionId, 'working…');
  await sleep(200); // quiet passes idleMs
  const idles = events.filter((e) => e.type === 'activity' && e.activity === 'idle');
  assert.equal(idles.length, 1, '5s-quiet rule: one idle transition, no flicker');
  host.emitData(s.sessionId, 'working again');
  const working = events.filter((e) => e.type === 'activity' && e.activity !== 'idle');
  assert.equal(working.length, 2);
});

test('idle fires at most once per quiet period (no repeated idle spam)', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' }, { activityIntervalMs: 50, idleMs: 80 });
  const s = await adapter.spawn('agent_a', 'kimi', {});
  const events: PtyEvent[] = [];
  adapter.subscribe(s.sessionId, (e) => events.push(e));

  host.emitData(s.sessionId, 'chunk');
  await sleep(300); // many idle windows pass
  const idles = events.filter((e) => e.type === 'activity' && e.activity === 'idle');
  assert.equal(idles.length, 1);
});

test('activity is per-session: two sessions coalesce independently', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' }, { activityIntervalMs: 100, idleMs: 1000 });
  const s1 = await adapter.spawn('agent_a', 'kimi', {});
  const s2 = await adapter.spawn('agent_a', 'kimi', {});
  const e1: PtyEvent[] = [];
  const e2: PtyEvent[] = [];
  adapter.subscribe(s1.sessionId, (e) => e1.push(e));
  adapter.subscribe(s2.sessionId, (e) => e2.push(e));

  host.emitData(s1.sessionId, 'a');
  host.emitData(s2.sessionId, 'b');
  assert.equal(e1.filter((e) => e.type === 'activity').length, 1);
  assert.equal(e2.filter((e) => e.type === 'activity').length, 1);
});

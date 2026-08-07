// S3 — terminal demux must be keyed by sessionId, not agentId: a second spawn
// of the SAME agent must not steal the first session's output/exit events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PtyEvent } from '../contract/schemas.js';
import { createTerminalAdapter } from '../core/providers/terminal.js';
import type { TerminalRuntimeLike } from '../core/providers/adapter.js';

/** Fake runtime honoring the TerminalRuntimeLike surface: keys everything by
 * the agentId string it is given (exactly like the real terminal host). */
function fakeRuntime() {
  const dataHandlers: Array<(agentId: string, data: string) => void> = [];
  const exitHandlers: Array<(agentId: string, code: number | null) => void> = [];
  const live = new Map<string, { status: 'running' | 'exited'; sent: string[] }>();
  const createdKeys: string[] = [];
  const runtime: TerminalRuntimeLike = {
    async create(opts) {
      const key = opts.agentId ?? 'unknown';
      live.set(key, { status: 'running', sent: [] });
      createdKeys.push(key);
      return { agentId: key, status: 'running', terminalPid: 4242 };
    },
    write(agentId, data) {
      const s = live.get(agentId);
      if (!s || s.status !== 'running') return false;
      s.sent.push(data);
      return true;
    },
    kill(agentId) {
      const s = live.get(agentId);
      if (!s) return false;
      s.status = 'exited';
      return true;
    },
    list() {
      return [...live.entries()].map(([agentId, s]) => ({ agentId, status: s.status }));
    },
    onData(cb) { dataHandlers.push(cb); },
    onExit(cb) { exitHandlers.push(cb); },
  };
  return {
    runtime,
    createdKeys,
    emitData: (key: string, data: string) => dataHandlers.forEach((h) => h(key, data)),
    emitExit: (key: string, code: number | null) => exitHandlers.forEach((h) => h(key, code)),
    live,
  };
}

test('S3: two concurrent sessions of one agent each receive their own output/exit events', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' });

  const s1 = await adapter.spawn('agent_same', 'kimi', {});
  const s2 = await adapter.spawn('agent_same', 'kimi', {});
  assert.notEqual(s1.sessionId, s2.sessionId);

  const events1: PtyEvent[] = [];
  const events2: PtyEvent[] = [];
  adapter.subscribe(s1.sessionId, (e) => events1.push(e));
  adapter.subscribe(s2.sessionId, (e) => events2.push(e));

  // the runtime must have been given a UNIQUE key per session (not agentId)
  const [key1, key2] = host.createdKeys;
  assert.notEqual(key1, key2);
  assert.notEqual(key1, 'agent_same');

  // output for session 1's terminal must reach ONLY session 1
  host.emitData(key1, 'hello from s1');
  host.emitData(key2, 'hello from s2');
  const out1 = events1.filter((e) => e.type === 'output').map((e) => (e as { data: string }).data);
  const out2 = events2.filter((e) => e.type === 'output').map((e) => (e as { data: string }).data);
  assert.deepEqual(out1, ['hello from s1'], 'session 1 received the wrong output (demux keyed by agentId?)');
  assert.deepEqual(out2, ['hello from s2'], 'session 2 must receive its own output');

  // exit of session 1's terminal reaches only session 1; session 2 stays running
  host.emitExit(key1, 0);
  assert.equal(events1.some((e) => e.type === 'exited'), true);
  assert.equal(events2.some((e) => e.type === 'exited'), false, 'session 2 must not see session 1\'s exit');
  assert.equal(adapter.attach(s1.sessionId)?.state, 'exited');
  assert.equal(adapter.attach(s2.sessionId)?.state, 'running');

  // send/close route to the right terminal too
  assert.equal(adapter.send(s2.sessionId, 'ping'), true);
  assert.equal(host.live.get(key2)?.sent.includes('ping'), true);
  assert.equal(host.live.get(key1)?.sent.includes('ping'), false);
});

test('S3: spawn result keeps the caller-facing agentId; runtime keying is internal', async () => {
  const host = fakeRuntime();
  const adapter = createTerminalAdapter(host.runtime, { cwd: '/tmp' });
  const s = await adapter.spawn('agent_visible', 'kimi', {});
  assert.equal(s.agentId, 'agent_visible');
  assert.match(s.sessionId, /^sess_/);
});

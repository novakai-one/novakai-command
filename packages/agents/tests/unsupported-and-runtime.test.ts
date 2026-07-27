// Slice 4 — typed UnsupportedOperation surface + the real-adapter wiring
// against a fake TerminalRuntimeLike (proves the demux to per-session PtyEvent
// streams without spawning a PTY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId, type SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';
import type { TerminalRuntimeLike } from '../core/providers/adapter.js';
import type { PtyEvent } from '../contract/schemas.js';

test('setSessionModel returns typed UnsupportedOperation blockedBy OD-C3 (R3-15)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-unsup-'));
  const agents = createAgentsContract(composeAgents({ root, principal: 'person_chris' }));
  const res = await agents.setSessionModel('sess_x' as SessionId, 'any-model');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.error.code, 'UnsupportedOperation');
    assert.equal(res.error.details.blockedBy, 'OD-C3');
    assert.equal(res.error.retryable, false);
  }
});

test('attachHook validates against the closed v1 sets (S2a shipped the engine; OD-C2 disposed)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-unsup-'));
  const agents = createAgentsContract(composeAgents({ root, principal: 'person_chris' }));
  // unknown agent → typed NotFound
  const res = await agents.attachHook('agent_x' as AgentId, 'onSpawn', { kind: 'log-to-trace', message: 'x' }, mintClientOpId());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, 'NotFound');
});

/** A TerminalRuntimeLike fake — same shape as TerminalManager/TerminalHostClient. */
class FakeRuntime implements TerminalRuntimeLike {
  private dataCb: ((agentId: string, data: string) => void) | null = null;
  private exitCbs: Array<(agentId: string, code: number | null) => void> = [];
  readonly created: Array<{ agentId?: string; provider?: string; cwd: string; title?: string }> = [];
  readonly written: Array<{ agentId: string; data: string }> = [];
  readonly killed: string[] = [];
  async create(options: { agentId?: string; provider?: string; cwd: string; title?: string }) {
    this.created.push(options);
    return { agentId: options.agentId ?? 'agent_runtime', status: 'running' as const, terminalPid: 777 };
  }
  write(agentId: string, data: string) { this.written.push({ agentId, data }); return true; }
  kill(agentId: string) { this.killed.push(agentId); return true; }
  list() { return this.created.map((c) => ({ agentId: c.agentId ?? 'agent_runtime', status: 'running' as const })); }
  onData(cb: (agentId: string, data: string) => void) { this.dataCb = cb; }
  onExit(cb: (agentId: string, code: number | null) => void) { this.exitCbs.push(cb); }
  emitData(agentId: string, data: string) { this.dataCb?.(agentId, data); }
  emitExit(agentId: string, code: number | null) { for (const cb of this.exitCbs) cb(agentId, code); }
}

test('terminal-host adapter: create/write/kill/onData/onExit demux into per-session PtyEvents', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-rt-'));
  const runtime = new FakeRuntime();
  const ctx = composeAgents({ root, principal: 'person_chris', terminalRuntime: runtime, cwd: '/tmp/work' });
  const agents = createAgentsContract(ctx);
  const def = await agents.defineAgent(
    { displayName: 'Real', provider: 'kimi', model: 'k2', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) return;
  const events: PtyEvent[] = [];
  const spawn = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  // spawn went through the existing runtime with provider + cwd; the runtime
  // key is the UNIQUE per-session key (S3), never the shared agentId — while
  // the caller-facing SpawnResponse keeps the durable agentId
  assert.equal(spawn.value.agentId, def.value.id);
  assert.equal(runtime.created[0].agentId, spawn.value.sessionId);
  assert.equal(runtime.created[0].provider, 'kimi');
  assert.equal(runtime.created[0].cwd, '/tmp/work');
  assert.equal(runtime.created[0].title, `agent:${def.value.id}`);
  const runtimeKey = runtime.created[0].agentId as string;
  const adapter = ctx.adapters.kimi;
  adapter.subscribe(spawn.value.sessionId, (e) => events.push(e));
  runtime.emitData(runtimeKey, 'partial output');
  assert.equal(events[0]?.type, 'output');
  assert.equal(events[0]?.type === 'output' && events[0].data, 'partial output');
  // send writes to the runtime keyed by the per-session runtime key
  assert.equal(adapter.send(spawn.value.sessionId, 'ping'), true);
  assert.deepEqual(runtime.written, [{ agentId: runtimeKey, data: 'ping' }]);
  // exit flows through as PtyEvent exited
  runtime.emitExit(runtimeKey, 0);
  const last = events.at(-1);
  assert.equal(last?.type, 'exited');
  // close kills via the runtime
  assert.equal(adapter.close(spawn.value.sessionId), true);
  assert.deepEqual(runtime.killed, [runtimeKey]);
});

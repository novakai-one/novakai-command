// B1a slice 3 — per-provider runtime registry + mock gating (§3 boot step 4).
// The server composes agents with a REAL runtime for kimi only; the mock
// adapter is registered only when config says dev.allowMock (closes M10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeAgents, createAgentsContract, mockOf } from '../contract/index.js';
import type { TerminalRuntimeLike } from '../core/providers/adapter.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-agents-registry-'));

function stubRuntime(label: string, spawned: string[]): TerminalRuntimeLike {
  return {
    async create(opts) { spawned.push(`${label}:${opts.agentId}`); return { agentId: opts.agentId!, status: 'running' }; },
    write() { return true; },
    kill() { return true; },
    list() { return []; },
    onData() { /* no output in this stub */ },
    onExit() { /* no exits in this stub */ },
  };
}

async function defineOn(ctx: ReturnType<typeof composeAgents>, provider: 'kimi' | 'claude' | 'mock') {
  const agents = createAgentsContract(ctx);
  const res = await agents.defineAgent(
    { displayName: `agent-${provider}`, provider, model: 'cli-default' },
    `op_${crypto.randomUUID()}` as never,
  );
  assert.equal(res.ok, true);
  return { agents, id: res.ok ? res.value.id : '' };
}

test('providerRuntimes binds a runtime per provider — kimi is real, others are not silently mocked', async () => {
  const spawned: string[] = [];
  const ctx = composeAgents({
    root: root(), principal: 'person_chris',
    providerRuntimes: { kimi: stubRuntime('kimi', spawned) },
    allowMock: false,
    cwd: process.cwd(),
  });

  const kimi = await defineOn(ctx, 'kimi');
  const okSpawn = await kimi.agents.spawnAgent(kimi.id as never);
  assert.equal(okSpawn.ok, true, 'kimi spawns on its configured runtime');
  assert.equal(spawned.length, 1);

  const claude = await defineOn(ctx, 'claude');
  const noRuntime = await claude.agents.spawnAgent(claude.id as never);
  assert.equal(noRuntime.ok, false, 'a provider with no configured runtime fails TYPED, never mock-in-disguise');
  if (!noRuntime.ok) assert.match(noRuntime.error.message, /claude/);
  assert.equal(spawned.length, 1, 'nothing was spawned for claude');
});

test('the mock adapter is absent unless allowMock is on (closes M10)', async () => {
  const off = composeAgents({ root: root(), principal: 'person_chris', allowMock: false, cwd: process.cwd() });
  assert.equal(mockOf(off), null, 'no __emit test seam in a production composition');
  const mock = await defineOn(off, 'mock');
  const refused = await mock.agents.spawnAgent(mock.id as never);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error.message, /mock/i);

  const on = composeAgents({ root: root(), principal: 'person_chris', allowMock: true, cwd: process.cwd() });
  assert.notEqual(mockOf(on), null);
  const allowed = await defineOn(on, 'mock');
  assert.equal((await allowed.agents.spawnAgent(allowed.id as never)).ok, true);
});

test('the pre-B1 composition shape still works: one terminalRuntime serves every CLI provider', async () => {
  const spawned: string[] = [];
  const ctx = composeAgents({
    root: root(), principal: 'person_chris',
    terminalRuntime: stubRuntime('shared', spawned), cwd: process.cwd(),
  });
  const claude = await defineOn(ctx, 'claude');
  assert.equal((await claude.agents.spawnAgent(claude.id as never)).ok, true);
  assert.equal(spawned.length, 1);
  assert.notEqual(mockOf(ctx), null, 'mock stays available by default for tests and the demo');
});

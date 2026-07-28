// S2a — hooks engine v1 (S2-pass1 §B + §22 rulings 2/3/9/14): lifecycle events
// onSpawn/onMessagePre/onMessagePost/onExit; many subscriptions per (agentId,
// event) in creation order; actions = log-to-trace + inject-context-text;
// every injection fires a system.action context.inject trace carrying the text;
// budgets 2s spawn-path / 500ms send-path; timeout = skip + hook_error; hooks
// never block the host action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId, type SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { composeEngine, queryTraceBound } from '@novakai/foundation/dist/contract/index.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { composeAgents, type AgentsContext } from '../core/composition.js';
import { createAgentsContract, type AgentsContract } from '../core/contract.js';
import { executeAction } from '../core/hooks/engine.js';
import { mockOf } from '../core/composition.js';

function freshCtx() {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-hooks-'));
  const ctx = composeAgents({ root, principal: 'person_chris' });
  return { root, ctx, agents: createAgentsContract(ctx) };
}

async function define(agents: AgentsContract, hooks: Array<{ event: string; action: unknown }> = []) {
  const res = await agents.defineAgent(
    { displayName: 'Hooked', provider: 'mock', model: 'm', hooks: hooks as never },
    mintClientOpId());
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('define failed');
  return res.value;
}

async function traces(root: string, action: string) {
  const engine = composeEngine({ root, capability: 'agents', allowedKinds: ['agent', 'skill'], principal: 'person_chris' });
  const page = await queryTraceBound(engine, {});
  return page.items.filter((t) => t.action === action);
}

test('attachHook appends subscriptions in creation order; detachHook removes one (single-object mutation)', async () => {
  const { agents } = freshCtx();
  const def = await define(agents);
  const id = def.id as AgentId;
  const a1 = await agents.attachHook(id, 'onSpawn', { kind: 'inject-context-text', text: 'first' }, mintClientOpId());
  const a2 = await agents.attachHook(id, 'onSpawn', { kind: 'inject-context-text', text: 'second' }, mintClientOpId());
  assert.equal(a1.ok && a2.ok, true);
  if (!a2.ok) return;
  assert.equal(a2.value.hooks.length, 2);
  assert.equal(a2.value.hooks[0].action.kind === 'inject-context-text' && a2.value.hooks[0].action.text, 'first');
  assert.equal(a2.value.hooks[1].action.kind === 'inject-context-text' && a2.value.hooks[1].action.text, 'second');
  const detached = await agents.detachHook(id, a2.value.hooks[0].id, mintClientOpId());
  assert.equal(detached.ok, true);
  if (!detached.ok) return;
  assert.equal(detached.value.hooks.length, 1);
  assert.equal(detached.value.hooks[0].action.kind === 'inject-context-text' && detached.value.hooks[0].action.text, 'second');
});

test('attachHook rejects an unknown event or unknown action kind (closed sets, §B)', async () => {
  const { agents } = freshCtx();
  const def = await define(agents);
  const badEvent = await agents.attachHook(def.id as AgentId, 'onExplode' as never,
    { kind: 'inject-context-text', text: 'x' }, mintClientOpId());
  assert.equal(badEvent.ok, false);
  const badAction = await agents.attachHook(def.id as AgentId, 'onSpawn',
    { kind: 'run-script', text: 'x' } as never, mintClientOpId());
  assert.equal(badAction.ok, false);
});

test('onSpawn injections merge by sequential concatenation and prepend the FIRST input only', async () => {
  const { ctx, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onSpawn', action: { kind: 'inject-context-text', text: 'A1' } },
    { event: 'onSpawn', action: { kind: 'inject-context-text', text: 'A2' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  const sent1 = await agents.sendToSession(spawn.value.sessionId as SessionId, 'hello');
  const sent2 = await agents.sendToSession(spawn.value.sessionId as SessionId, 'world');
  assert.equal(sent1 && sent2, true);
  const rec = mockOf(ctx)!.__session(spawn.value.sessionId)!;
  assert.equal(rec.sent[0], 'A1\nA2\nhello'); // creation order, concatenated
  assert.equal(rec.sent[1], 'world');          // once, never repeated
});

test('onMessagePre injection prepends the CURRENT send; every injection fires a context.inject trace carrying the text', async () => {
  const { root, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'PRE' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  await agents.sendToSession(spawn.value.sessionId as SessionId, 'hi');
  const injectTraces = await traces(root, 'context.inject');
  assert.equal(injectTraces.length, 1);
  assert.equal(injectTraces[0].opKind, 'system.action');
  assert.equal(injectTraces[0].target.kind, 'agent');
  assert.equal(injectTraces[0].target.id, def.id);
  assert.equal((injectTraces[0].meta as { text: string }).text, 'PRE');
  assert.equal((injectTraces[0].meta as { event: string }).event, 'onMessagePre');
});

test('log-to-trace hook fires a hook_log system.action line (onMessagePost)', async () => {
  const { root, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onMessagePost', action: { kind: 'log-to-trace', message: 'message handled' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  await agents.sendToSession(spawn.value.sessionId as SessionId, 'hi');
  const logs = await traces(root, 'hook_log');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].opKind, 'system.action');
  assert.equal((logs[0].meta as { message: string }).message, 'message handled');
  assert.equal((logs[0].meta as { event: string }).event, 'onMessagePost');
});

test('hook timeout = skipped + hook_error trace; the send is NOT blocked (L13: 500ms TOTAL chain budget)', async () => {
  const { root, ctx, agents } = freshCtx();
  // @internal test seam: make one action hang forever
  ctx.__hookExecutor = async (action, refs) => {
    if (action.kind === 'inject-context-text' && action.text === 'SLOW') {
      return new Promise<string | void>(() => undefined); // never resolves
    }
    return executeAction(ctx, action, refs);
  };
  const def = await define(agents, [
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'SLOW' } },
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'FAST' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  const started = Date.now();
  const sent = await agents.sendToSession(spawn.value.sessionId as SessionId, 'hi');
  assert.equal(sent, true); // host action completed despite the hung hook
  assert.ok(Date.now() - started < 2000, 'send-path budget must stay near 500ms');
  const rec = mockOf(ctx)!.__session(spawn.value.sessionId)!;
  // L13 ruled: the chain shares ONE 500ms budget — SLOW consumed it, so FAST
  // is skipped too (chain budget exhausted), never a per-hook 500ms.
  assert.equal(rec.sent[0], 'hi');
  const errors = await traces(root, 'hook_error');
  assert.equal(errors.length, 2);
  assert.match((errors[0].meta as { reason: string }).reason, /timeout/);
  assert.match((errors[1].meta as { reason: string }).reason, /budget/);
});

test('L13: two healthy-but-slow hooks share the 500ms chain budget — the second is skipped, never silently', async () => {
  const { root, ctx, agents } = freshCtx();
  ctx.__hookExecutor = async (action, refs) => {
    if (action.kind === 'inject-context-text') {
      await new Promise((r) => setTimeout(r, 320)); // each hook is "healthy" but slow
    }
    return executeAction(ctx, action, refs);
  };
  const def = await define(agents, [
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'FIRST' } },
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'SECOND' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  const started = Date.now();
  const sent = await agents.sendToSession(spawn.value.sessionId as SessionId, 'hi');
  assert.equal(sent, true);
  assert.ok(Date.now() - started < 900, 'chain total stays ~500ms, not 2×500ms');
  const rec = mockOf(ctx)!.__session(spawn.value.sessionId)!;
  assert.equal(rec.sent[0], 'FIRST\nhi'); // SECOND skipped: budget was gone
  const errors = await traces(root, 'hook_error');
  assert.equal(errors.length, 1);
  assert.match((errors[0].meta as { reason: string }).reason, /budget|timeout/);
});

test('M7: a trace-write failure inside a hook is NEVER silent — hook_error trace records it, host action unaffected', async () => {
  const { root, ctx, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onSpawn', action: { kind: 'log-to-trace', message: 'x' } },
  ]);
  // one injected trace failure: the hook_log write fails → surfaced as hook_error
  (ctx.handle.__engine as { failNextTraceAppend?: { cause: string } }).failNextTraceAppend = { cause: 'disk full (injected)' };
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true); // host action unaffected
  const errors = await traces(root, 'hook_error');
  assert.equal(errors.length, 1);
  assert.match((errors[0].meta as { reason: string }).reason, /trace|disk full/i);
});

test('M7: if even the hook_error trace fails, the failure is recorded on the context (never silent)', async () => {
  const { ctx, agents } = freshCtx();
  ctx.__hookExecutor = async () => { throw new Error('boom'); };
  const def = await define(agents, [
    { event: 'onSpawn', action: { kind: 'log-to-trace', message: 'x' } },
  ]);
  // the hook_error trace write itself fails → the failure must still surface
  (ctx.handle.__engine as { failNextTraceAppend?: { cause: string } }).failNextTraceAppend = { cause: 'disk full (injected)' };
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  assert.equal(ctx.hookTraceFailures.length, 1, 'the double failure is inspectable, never swallowed');
  assert.match(ctx.hookTraceFailures[0].reason, /boom/);
  assert.match(ctx.hookTraceFailures[0].reason, /disk full/);
});

test('L14: when adapter.send fails, the injection is NOT consumed and NO context.inject trace fires', async () => {
  const { root, ctx, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onMessagePre', action: { kind: 'inject-context-text', text: 'PRE' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  // kill the session so adapter.send returns false
  agents.closeSession(spawn.value.sessionId as SessionId);
  await new Promise((r) => setTimeout(r, 30));
  const sent = await agents.sendToSession(spawn.value.sessionId as SessionId, 'hi');
  assert.equal(sent, false);
  const injectTraces = await traces(root, 'context.inject');
  assert.equal(injectTraces.length, 0, 'no provenance trace for an injection that never went out');
  const pending = ctx.pendingInjections.get(spawn.value.sessionId) ?? [];
  assert.deepEqual(pending.map((p) => p.text), ['PRE'], 'the injection is re-buffered, not consumed');
});

test('a failing onSpawn hook never blocks the spawn (liveness wins, DEC-S2-3)', async () => {
  const { root, ctx, agents } = freshCtx();
  ctx.__hookExecutor = async (action, refs) => {
    if (action.kind === 'log-to-trace') throw new Error('boom');
    return executeAction(ctx, action, refs);
  };
  const def = await define(agents, [
    { event: 'onSpawn', action: { kind: 'log-to-trace', message: 'x' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true); // spawn succeeded despite the hook failure
  const errors = await traces(root, 'hook_error');
  assert.equal(errors.length, 1);
  assert.match((errors[0].meta as { reason: string }).reason, /boom/);
});

test('onExit fires when the session closes (hook_log, once)', async () => {
  const { root, agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onExit', action: { kind: 'log-to-trace', message: 'bye' } },
  ]);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
  if (!spawn.ok) return;
  agents.closeSession(spawn.value.sessionId as SessionId);
  await new Promise((r) => setTimeout(r, 50)); // exit propagation is async
  const logs = (await traces(root, 'hook_log'))
    .filter((t) => (t.meta as { event?: string }).event === 'onExit');
  assert.equal(logs.length, 1);
});

test('spawn without hooks still works; getAgent shows the stored subscriptions', async () => {
  const { agents } = freshCtx();
  const def = await define(agents, [
    { event: 'onSpawn', action: { kind: 'log-to-trace', message: 'spawned!' } },
  ]);
  const got = await agents.getAgent(def.id as AgentId);
  assert.equal(got.ok && !isAbsent(got.value) && got.value.hooks.length, 1);
  const spawn = await agents.spawnAgent(def.id as AgentId);
  assert.equal(spawn.ok, true);
});

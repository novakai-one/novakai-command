// B1b slice 3 — the ADAPTER CONFORMANCE SUITE (R3-28 / AGT-001).
//
// ONE suite, four adapters. Every case below runs verbatim against kimi, codex,
// claude (each behind a real fake CLI executable) and mock. The point is not
// that four adapters exist — it is that a consumer cannot tell them apart
// through the terminal mini-contract. Anything a provider does differently has
// to show up in this file as a DECLARED difference (the model-switch mechanism
// is the only one), never as a surprise at a call site.
//
// The suite crosses the same seam production crosses: TerminalAdapter. It never
// reaches into a runtime's internals, so an adapter can be rewritten underneath
// it without touching a line here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import type { PtyEvent, ProviderName } from '../contract/schemas.js';
import type { TerminalAdapter } from '../core/providers/adapter.js';
import { createTerminalAdapter } from '../core/providers/terminal.js';
import { createMockAdapter } from '../core/providers/mock.js';
import { createKimiCliRuntime } from '../core/providers/kimi.js';
import { createCodexCliRuntime } from '../core/providers/codex.js';
import { createClaudeCliRuntime } from '../core/providers/claude.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

// ── the rig each provider supplies ─────────────────────────────────────────

interface Rig {
  adapter: TerminalAdapter;
  /** Send input and resolve only once the provider's reply has been delivered. */
  say(sessionId: string, input: string): Promise<void>;
}

interface ConformanceCase {
  name: ProviderName;
  /** OD-C3: does this provider declare a VERIFIED mid-session model mechanism? */
  declaresModelSwitch: boolean;
  rig(reply: string): Rig;
}

/** Writes an executable that prints `body` (a JS snippet) and exits 0. */
function fakeCli(prefix: string, body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const cliPath = path.join(dir, prefix.replace(/-$/, ''));
  writeFileSync(cliPath, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

/** codex insists on a git-repo cwd; a bare .git dir satisfies the detection. */
function gitCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'conformance-git-'));
  mkdirSync(path.join(dir, '.git'));
  return dir;
}

const CASES: ConformanceCase[] = [
  {
    name: 'kimi',
    declaresModelSwitch: true, // OD-C3 RULED: `-S <id> -m <alias>`, sticky
    rig(reply) {
      const cliPath = fakeCli('fake-kimi-', `
process.stdout.write(JSON.stringify({ role: 'assistant', content: ${JSON.stringify(reply)} }) + '\\n');
process.stdout.write(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'k1' }) + '\\n');`);
      const cwd = gitCwd();
      const runtime = createKimiCliRuntime({ cwd, cliPath });
      const adapter = createTerminalAdapter(runtime, { cwd, provider: 'kimi' });
      return {
        adapter,
        async say(sessionId, input) {
          adapter.send(sessionId, input);
          await runtime.drain(sessionId);
        },
      };
    },
  },
  {
    name: 'codex',
    declaresModelSwitch: false,
    rig(reply) {
      const cliPath = fakeCli('fake-codex-', `
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'c1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(reply)} } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');`);
      const cwd = gitCwd();
      const runtime = createCodexCliRuntime({ cwd, cliPath });
      const adapter = createTerminalAdapter(runtime, { cwd, provider: 'codex' });
      return {
        adapter,
        async say(sessionId, input) {
          adapter.send(sessionId, input);
          await runtime.drain(sessionId);
        },
      };
    },
  },
  {
    name: 'claude',
    declaresModelSwitch: false,
    rig(reply) {
      const cliPath = fakeCli('fake-claude-', `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 'a1', message: { content: [{ type: 'text', text: ${JSON.stringify(reply)} }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'a1', result: ${JSON.stringify(reply)}, usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');`);
      const cwd = gitCwd();
      const runtime = createClaudeCliRuntime({ cwd, cliPath });
      const adapter = createTerminalAdapter(runtime, { cwd, provider: 'claude' });
      return {
        adapter,
        async say(sessionId, input) {
          adapter.send(sessionId, input);
          await runtime.drain(sessionId);
        },
      };
    },
  },
  {
    name: 'mock',
    declaresModelSwitch: false,
    rig(reply) {
      const adapter = createMockAdapter();
      return {
        adapter,
        async say(sessionId, input) {
          adapter.send(sessionId, input);
          adapter.__emit(sessionId, {
            type: 'output', sessionId, at: new Date().toISOString(), data: reply,
          });
        },
      };
    },
  },
];

/** Collect a session's PtyEvents through the contract's own subscribe(). */
function record(adapter: TerminalAdapter, sessionId: string): PtyEvent[] {
  const events: PtyEvent[] = [];
  adapter.subscribe(sessionId, (e) => events.push(e));
  return events;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// ── the shared suite ───────────────────────────────────────────────────────

for (const c of CASES) {
  test(`[${c.name}] spawn returns a sess_ handle carrying agent, provider and model`, async () => {
    const rig = c.rig('x');
    const spawned = await rig.adapter.spawn('agent_1', c.name, { model: 'm-1', cwd: gitCwd() });
    assert.match(spawned.sessionId, /^sess_/, 'sessionId shape is contract, not provider detail');
    assert.equal(spawned.agentId, 'agent_1');
    assert.equal(spawned.provider, c.name);
    assert.equal(spawned.model, 'm-1', 'the at-spawn model is echoed back on every provider');
  });

  test(`[${c.name}] attach: unknown session is null, a live session is running`, async () => {
    const rig = c.rig('x');
    assert.equal(rig.adapter.attach('sess_nope'), null);
    const spawned = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    assert.deepEqual(rig.adapter.attach(spawned.sessionId), {
      sessionId: spawned.sessionId, state: 'running',
    });
  });

  test(`[${c.name}] send to an unknown session is a refusal, never a throw`, async () => {
    const rig = c.rig('x');
    assert.equal(rig.adapter.send('sess_nope', 'hello'), false);
  });

  test(`[${c.name}] a sent message produces output events carrying the reply`, async () => {
    const rig = c.rig('conformance-reply');
    const spawned = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    const events = record(rig.adapter, spawned.sessionId);

    await rig.say(spawned.sessionId, 'ping');
    await settle();

    const text = events.filter((e) => e.type === 'output').map((e) => e.data).join('');
    assert.match(text, /conformance-reply/, 'the reply crosses the seam as output PtyEvents');
    assert.ok(events.every((e) => e.sessionId === spawned.sessionId),
      'every event is stamped with its own session — no cross-session leakage');
  });

  test(`[${c.name}] unsubscribe stops delivery`, async () => {
    const rig = c.rig('after-unsub');
    const spawned = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    const events: PtyEvent[] = [];
    const off = rig.adapter.subscribe(spawned.sessionId, (e) => events.push(e));
    off();

    await rig.say(spawned.sessionId, 'ping');
    await settle();

    assert.equal(events.filter((e) => e.type === 'output').length, 0);
  });

  test(`[${c.name}] close ends the session: exited state, exited event, sends refused`, async () => {
    const rig = c.rig('x');
    const spawned = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    const events = record(rig.adapter, spawned.sessionId);

    assert.equal(rig.adapter.close(spawned.sessionId), true);
    await settle();

    assert.deepEqual(rig.adapter.attach(spawned.sessionId), {
      sessionId: spawned.sessionId, state: 'exited',
    });
    assert.ok(events.some((e) => e.type === 'exited'), 'closing is announced, never silent');
    assert.equal(rig.adapter.send(spawned.sessionId, 'too late'), false);
  });

  test(`[${c.name}] close on an unknown session is a refusal, never a throw`, () => {
    const rig = c.rig('x');
    assert.equal(rig.adapter.close('sess_nope'), false);
  });

  test(`[${c.name}] the model-switch mechanism is DECLARED, not discovered (OD-C3)`, async () => {
    const rig = c.rig('x');
    const spawned = await rig.adapter.spawn('agent_1', c.name, { model: 'm-1', cwd: gitCwd() });
    if (c.declaresModelSwitch) {
      assert.equal(typeof rig.adapter.setSessionModel, 'function');
      assert.equal(rig.adapter.setSessionModel!(spawned.sessionId, 'm-2'), true);
      assert.equal(rig.adapter.setSessionModel!('sess_nope', 'm-2'), false,
        'unknown session = false, never a throw');
    } else {
      assert.equal(rig.adapter.setSessionModel, undefined,
        'no verified mechanism ⇒ no method ⇒ typed UnsupportedOperation upstream');
    }
  });

  test(`[${c.name}] two sessions of one agent stay routed apart`, async () => {
    const rig = c.rig('routed');
    const a = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    const b = await rig.adapter.spawn('agent_1', c.name, { cwd: gitCwd() });
    assert.notEqual(a.sessionId, b.sessionId, 'a second spawn never reuses the first key');
    const eventsA = record(rig.adapter, a.sessionId);
    const eventsB = record(rig.adapter, b.sessionId);

    await rig.say(a.sessionId, 'only to a');
    await settle();

    assert.ok(eventsA.some((e) => e.type === 'output'));
    assert.equal(eventsB.filter((e) => e.type === 'output').length, 0,
      'S3: per-session runtime keys — one agent, two sessions, no crosstalk');
  });
}

// ── the exit-evidence case: ONE agent def, three real providers ────────────

test('the SAME agent def spawns equivalently on kimi, codex and claude (§10 B1b)', async () => {
  const cwd = gitCwd();
  const kimiCli = fakeCli('fake-kimi-', `
process.stdout.write(JSON.stringify({ role: 'assistant', content: 'equivalent' }) + '\\n');`);
  const codexCli = fakeCli('fake-codex-', `
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'equivalent' } }) + '\\n');`);
  const claudeCli = fakeCli('fake-claude-', `
process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 'a1', message: { content: [{ type: 'text', text: 'equivalent' }] } }) + '\\n');`);

  const root = mkdtempSync(path.join(tmpdir(), 'nvk-conformance-'));
  const ctx = composeAgents({
    root,
    principal: 'person_chris',
    cwd,
    allowMock: false,
    providerRuntimes: {
      kimi: createKimiCliRuntime({ cwd, cliPath: kimiCli }),
      codex: createCodexCliRuntime({ cwd, cliPath: codexCli }),
      claude: createClaudeCliRuntime({ cwd, cliPath: claudeCli }),
    },
  });
  const agents = createAgentsContract(ctx);

  // ONE definition shape, three providers — the only field that differs.
  const results = [];
  for (const provider of ['kimi', 'codex', 'claude'] as const) {
    const def = await agents.defineAgent(
      {
        displayName: `Supervised ${provider}`, provider, model: 'cli-default',
        permissionLevel: 'private', hooks: [], status: 'defined',
      },
      mintClientOpId());
    assert.equal(def.ok, true, `defineAgent failed for ${provider}`);
    if (!def.ok) return;
    const spawned = await agents.spawnAgent(def.value.id as AgentId);
    assert.equal(spawned.ok, true, `spawnAgent failed for ${provider}`);
    if (!spawned.ok) return;
    results.push(spawned.value);
  }

  for (const [i, provider] of (['kimi', 'codex', 'claude'] as const).entries()) {
    assert.match(results[i]!.sessionId, /^sess_/);
    assert.equal(results[i]!.provider, provider);
    assert.equal(results[i]!.model, 'cli-default',
      'the def model resolves identically on every provider');
  }
  assert.equal(new Set(results.map((r) => r.sessionId)).size, 3, 'three distinct sessions');
});

test('a provider with NO runtime bound still fails TYPED at spawn (B1a behaviour kept)', async () => {
  const cwd = gitCwd();
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-conformance-unbound-'));
  const ctx = composeAgents({
    root, principal: 'person_chris', cwd, allowMock: false,
    // codex bound, claude deliberately NOT — an unbound provider must refuse
    // loudly rather than quietly answer as a mock wearing its name.
    providerRuntimes: {
      codex: createCodexCliRuntime({ cwd, cliPath: fakeCli('fake-codex-', 'process.exit(0)') }),
    },
  });
  const agents = createAgentsContract(ctx);
  const def = await agents.defineAgent(
    {
      displayName: 'Unbound', provider: 'claude', model: 'cli-default',
      permissionLevel: 'private', hooks: [], status: 'defined',
    },
    mintClientOpId());
  assert.equal(def.ok, true);
  if (!def.ok) return;

  const spawned = await agents.spawnAgent(def.value.id as AgentId);
  assert.equal(spawned.ok, false);
  if (spawned.ok) return;
  const error = spawned.error as { code: string; details: { provider?: string; cause?: string } };
  assert.equal(error.code, 'SpawnFailed');
  assert.equal(error.details.provider, 'claude');
  assert.match(String(error.details.cause), /no runtime is configured for provider "claude"/,
    'the refusal names the missing binding — never a mock answering in claude\'s name');
});

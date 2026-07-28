// B1a slice 7 — the composition root (DEC-B1-2) and the B1a exit behaviours,
// exercised through the real boot path against a real (temp) .novakai root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootServer, type NovakaiServer } from '../core/boot.js';
import { openConfigStore } from '../contract/index.js';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { fakeKimi } from './fakeKimi.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-boot-'));

/** The §13 disposition 4 cold-start runbook, run for real. */
async function mintChris(dir: string): Promise<void> {
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const token = opened.value.mintPrincipalToken({
    personId: 'person_chris', roles: ['Human'], grants: ['layout', 'settings', 'conversationView'],
  });
  await opened.value.set(
    { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: token.id },
    mintClientOpId(),
  );
}

async function boot(dir: string, options: { cliPath?: string } = {}): Promise<NovakaiServer> {
  const res = await bootServer({
    root: dir, port: 0, cwd: dir, transcripts: false, watchdogDir: dir,
    ...(options.cliPath ? { kimiCliPath: options.cliPath } : {}),
  });
  if (!res.ok) throw new Error(`boot failed: ${res.error.code} ${res.error.message}`);
  return res.value;
}

test('boot refuses to start without a human principal, and names the runbook', async () => {
  const dir = root();
  const res = await bootServer({ root: dir, port: 0, cwd: dir, transcripts: false, watchdogDir: dir });
  if (res.ok) { await res.value.close(); assert.fail('boot must refuse without a human principal'); }
  assert.equal(res.error.code, 'NoHumanPrincipal');
  assert.match(res.error.message, /nvk-token.*mint/s, 'the operator is told exactly what to run');
});

test('boot runs all nine steps in order and serves bootstrap.json', async () => {
  const dir = root();
  await mintChris(dir);
  const server = await boot(dir);

  assert.deepEqual(server.steps.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(
    server.steps.map((s) => s.name),
    ['config', 'foundation', 'messaging', 'agents', 'transcript', 'shell', 'sessions', 'supervision', 'transport'],
  );

  const bootstrap = await (await fetch(`${server.url}/bootstrap.json`)).json() as { token: string; protocolVersion: number };
  assert.equal(bootstrap.token, server.token);
  assert.equal(bootstrap.protocolVersion, 1);
  await server.close();
});

test('the method surface is the proven set minus the demo affordances', async () => {
  const dir = root();
  await mintChris(dir);
  const server = await boot(dir);
  const methods = Object.keys((await import('../core/methods.js')).buildMethods(server.runtime)).sort();

  assert.ok(methods.includes('spawnAgentConversation'));
  assert.equal(methods.includes('spawnMockAgent'), false, 'demo affordance is gone');
  assert.equal(methods.includes('spawnRealKimi'), false, 'demo affordance is gone');
  for (const proven of ['listConversations', 'createConversation', 'getMessages', 'sendMessage',
    'getLayout', 'setLayout', 'getSettings', 'setSetting', 'listAgents', 'defineAgent',
    'updateAgent', 'setAgentModel', 'listSkills', 'publishFocus', 'getFocus',
    'pinConversation', 'archiveConversation', 'getCapabilities']) {
    assert.ok(methods.includes(proven), `the demo's ${proven} survives`);
  }
  for (const lifecycle of ['listSessions', 'terminateSession', 'getUsageTable']) {
    assert.ok(methods.includes(lifecycle), `${lifecycle} is part of nvk-ws v1`);
  }
  await server.close();
});

test('spawn → send → the provider reply lands in the thread, and the session is registered', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ reply: 'hello Chris', sessionId: 'session_boot_1' });
  const server = await boot(dir, { cliPath: cli.cliPath });
  const methods = (await import('../core/methods.js')).buildMethods(server.runtime);

  const spawned = await methods.spawnAgentConversation!({ title: 'Kimi' } as never) as
    { ok: boolean; conversation: { id: string }; sessionId: string };
  assert.equal(spawned.ok, true);

  // DEC-B1-8: a person was provisioned for this agent — one binding, no pool.
  const config = server.runtime.configStore.current();
  assert.equal(config.bindings.length, 1);
  assert.equal(config.principals.length, 2, 'chris + one agent person');

  // The session is in the registry AND in the watchdog's table.
  const sessions = await server.sessions.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]!.sessionId, spawned.sessionId);
  assert.equal(sessions[0]!.provider, 'kimi');
  const watchdogEntries = JSON.parse(readFileSync(path.join(dir, '.watchdog-sessions.json'), 'utf8')) as
    { sessions: Array<{ sessionId: string; status: string }> };
  assert.equal(watchdogEntries.sessions[0]!.sessionId, spawned.sessionId);
  assert.equal(watchdogEntries.sessions[0]!.status, 'active');

  const sent = await methods.sendMessage!({ conversationId: spawned.conversation.id, text: 'hi' } as never) as
    { ok: boolean; error?: string };
  assert.equal(sent.ok, true, sent.error);

  await server.runtime.kimiRuntime.drain(spawned.sessionId);
  await new Promise((r) => setTimeout(r, 150)); // the live lane posts on the next tick

  const messages = await methods.getMessages!({ conversationId: spawned.conversation.id } as never) as
    Array<{ senderId: string; text: string }>;
  assert.deepEqual(messages.map((m) => m.text), ['hi', 'hello Chris']);
  assert.equal(messages[0]!.senderId, 'me');
  assert.notEqual(messages[1]!.senderId, 'me', 'the reply comes from the agent person, in the real thread');

  // The resume handle was learned and persisted (DEC-B1-6).
  assert.equal((await server.sessions.get(spawned.sessionId))!.providerConversationId, 'session_boot_1');
  assert.equal((await server.sessions.get(spawned.sessionId))!.turns, 1);
  await server.close();
});

test('kill the server mid-session → restart → the same conversation resumes on the same CLI session', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ sessionId: 'session_boot_2' });

  const first = await boot(dir, { cliPath: cli.cliPath });
  const firstMethods = (await import('../core/methods.js')).buildMethods(first.runtime);
  const spawned = await firstMethods.spawnAgentConversation!({ title: 'Kimi' } as never) as
    { conversation: { id: string }; sessionId: string };
  await firstMethods.sendMessage!({ conversationId: spawned.conversation.id, text: 'turn one' } as never);
  await first.runtime.kimiRuntime.drain(spawned.sessionId);
  await firstMethods.pinConversation!({ id: spawned.conversation.id, pinned: true, clientOpId: mintClientOpId() } as never);
  await first.close();

  const second = await boot(dir, { cliPath: cli.cliPath });
  const secondMethods = (await import('../core/methods.js')).buildMethods(second.runtime);

  const conversations = await secondMethods.listConversations!(undefined as never) as
    Array<{ id: string; pinned: boolean }>;
  const restored = conversations.find((c) => c.id === spawned.conversation.id);
  assert.ok(restored, 'the conversation survived the restart');
  assert.equal(restored.pinned, true, 'and so did its view state');

  const resumable = await second.sessions.resumable();
  assert.equal(resumable.length, 1);
  assert.equal(resumable[0]!.providerConversationId, 'session_boot_2',
    'the resume handle survived — the next send continues the same CLI conversation');
  assert.equal(second.interrupted.length, 0, 'a clean shutdown leaves nothing interrupted');

  // The regression the browser caught: a restored conversation must still REACH
  // the provider. Rebinding only the registry left the thread looking alive
  // while every send went nowhere.
  const before = cli.invocations().length;
  const sent = await secondMethods.sendMessage!(
    { conversationId: spawned.conversation.id, text: 'turn two, after the restart' } as never,
  ) as { ok: boolean; error?: string };
  assert.equal(sent.ok, true, sent.error);
  await second.runtime.kimiRuntime.drain(spawned.sessionId);

  const argv = cli.invocations();
  assert.equal(argv.length, before + 1, 'the restarted server really spawned the provider');
  const last = argv[argv.length - 1]!;
  // AGT-006: every session-bound input carries the send-time focus snapshot, so
  // the prompt is the context line + the text.
  assert.match(last[last.indexOf('-p') + 1]!, /turn two, after the restart$/);
  assert.deepEqual(last.slice(-2), ['-S', 'session_boot_2'],
    'and it resumed the SAME CLI conversation');
  await second.close();
});

test('a reply in flight when the server dies is surfaced as ReplyInterrupted, never auto-retried', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ sessionId: 'session_boot_3', delayMs: 1500 }); // still "generating" when we die

  const first = await boot(dir, { cliPath: cli.cliPath });
  const firstMethods = (await import('../core/methods.js')).buildMethods(first.runtime);
  const spawned = await firstMethods.spawnAgentConversation!({ title: 'Kimi' } as never) as
    { conversation: { id: string }; sessionId: string };
  await firstMethods.sendMessage!({ conversationId: spawned.conversation.id, text: 'never answered' } as never);
  assert.equal((await first.sessions.get(spawned.sessionId))!.inFlight.status, 'generating');
  await first.close(); // ← the crash

  const invocationsBefore = cli.invocations().length;
  const second = await boot(dir, { cliPath: cli.cliPath });
  assert.equal(second.interrupted.length, 1);
  assert.equal(second.interrupted[0]!.reason, 'ReplyInterrupted');
  assert.equal(second.interrupted[0]!.sessionId, spawned.sessionId);

  const record = (await second.sessions.get(spawned.sessionId))!;
  assert.equal(record.inFlight.status, 'none');
  assert.equal(record.lastInterruption!.reason, 'ReplyInterrupted');

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(cli.invocations().length, invocationsBefore, 'the interrupted send was NEVER re-issued');

  const usage = await (await import('../core/methods.js')).buildMethods(second.runtime).getUsageTable!(undefined as never) as
    { rows: Array<{ interrupted: string | null }> };
  assert.notEqual(usage.rows[0]!.interrupted, null, 'the interruption is visible to the operator');
  await second.close();
});

test('booting twice never duplicates the agent definition (G4 lesson, promoted)', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi();

  const first = await boot(dir, { cliPath: cli.cliPath });
  await (await import('../core/methods.js')).buildMethods(first.runtime)
    .spawnAgentConversation!({ title: 'Kimi' } as never);
  await first.close();

  const second = await boot(dir, { cliPath: cli.cliPath });
  const secondMethods = (await import('../core/methods.js')).buildMethods(second.runtime);
  await secondMethods.spawnAgentConversation!({ title: 'Kimi' } as never);

  const agents = await secondMethods.listAgents!(undefined as never) as Array<{ displayName: string }>;
  assert.equal(agents.filter((a) => a.displayName === 'Kimi').length, 1);
  assert.equal(second.runtime.configStore.current().bindings.length, 1, 'and no second person is provisioned');
  await second.close();
});

test('config.jsonl is created under the real root and never holds a bearer', async () => {
  const dir = root();
  await mintChris(dir);
  const server = await boot(dir);
  assert.ok(existsSync(path.join(dir, 'config.jsonl')));
  const raw = readFileSync(path.join(dir, 'config.jsonl'), 'utf8');
  for (const principal of server.config.principals) {
    assert.equal(raw.includes(principal.token), false);
  }
  await server.close();
});

// Ported from the deleted demo suite (shell tests G3/G4): the regressions those
// tests guarded are now guarded against the code that replaced the demo's
// person pool (DEC-B1-8) and its in-code seeding (config materialization).
test('G3, re-expressed: two agent conversations get DISTINCT persons and DISTINCT threads', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ reply: 'ack' });
  const server = await boot(dir, { cliPath: cli.cliPath });
  const methods = (await import('../core/methods.js')).buildMethods(server.runtime);

  const one = await methods.spawnAgentConversation!({ title: 'Alpha' } as never) as
    { conversation: { id: string }; sessionId: string };
  const two = await methods.spawnAgentConversation!({ title: 'Beta' } as never) as
    { conversation: { id: string }; sessionId: string };

  const bindings = server.runtime.configStore.current().bindings;
  assert.equal(bindings.length, 2);
  assert.notEqual(bindings[0]!.personId, bindings[1]!.personId, 'one person per agent, never shared');

  await methods.sendMessage!({ conversationId: one.conversation.id, text: 'to alpha' } as never);
  await methods.sendMessage!({ conversationId: two.conversation.id, text: 'to beta' } as never);

  const alpha = await methods.getMessages!({ conversationId: one.conversation.id } as never) as Array<{ text: string }>;
  const beta = await methods.getMessages!({ conversationId: two.conversation.id } as never) as Array<{ text: string }>;
  assert.deepEqual(alpha.map((m) => m.text), ['to alpha'], 'alpha only sees its own thread');
  assert.deepEqual(beta.map((m) => m.text), ['to beta'], 'beta only sees its own thread');
  await server.close();
});

test('G4, re-expressed: the same display name on a DIFFERENT provider is a different agent', async () => {
  const dir = root();
  await mintChris(dir);
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  if (!opened.ok) throw new Error('config unavailable');
  await opened.value.set({ configKind: 'dev', allowMock: true }, mintClientOpId());

  const cli = fakeKimi();
  const server = await boot(dir, { cliPath: cli.cliPath });
  const methods = (await import('../core/methods.js')).buildMethods(server.runtime);

  await methods.spawnAgentConversation!({ title: 'Kimi', provider: 'kimi' } as never);
  await methods.spawnAgentConversation!({ title: 'Kimi', provider: 'mock' } as never);

  const agents = await methods.listAgents!(undefined as never) as Array<{ displayName: string; provider: string }>;
  const named = agents.filter((a) => a.displayName === 'Kimi');
  assert.equal(named.length, 2, 'mock Kimi is not the same object as real Kimi');
  assert.deepEqual(named.map((a) => a.provider).sort(), ['kimi', 'mock']);
  await server.close();
});

test('a conversation that was only ever SENT to still relinks to its provider after a restart', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ sessionId: 'session_boot_4' });

  const first = await boot(dir, { cliPath: cli.cliPath });
  const firstMethods = (await import('../core/methods.js')).buildMethods(first.runtime);
  const spawned = await firstMethods.spawnAgentConversation!({ title: 'Kimi' } as never) as
    { conversation: { id: string }; sessionId: string };
  // ONLY a send — nothing pins, renames or archives this conversation. The
  // thread id is learned here and must be persisted here.
  await firstMethods.sendMessage!({ conversationId: spawned.conversation.id, text: 'only ever sent' } as never);
  await first.runtime.kimiRuntime.drain(spawned.sessionId);
  await first.close();

  const second = await boot(dir, { cliPath: cli.cliPath });
  const secondMethods = (await import('../core/methods.js')).buildMethods(second.runtime);
  const before = cli.invocations().length;
  const sent = await secondMethods.sendMessage!(
    { conversationId: spawned.conversation.id, text: 'after restart' } as never,
  ) as { ok: boolean; error?: string };
  assert.equal(sent.ok, true, sent.error);
  await second.runtime.kimiRuntime.drain(spawned.sessionId);

  const argv = cli.invocations();
  assert.equal(argv.length, before + 1, 'the send reached the provider, not a dead end');
  assert.equal(argv[argv.length - 1]![argv[argv.length - 1]!.indexOf('-S') + 1], 'session_boot_4');
  await second.close();
});

test('a focus change NEVER burns a provider turn on a real CLI session', async () => {
  const dir = root();
  await mintChris(dir);
  const cli = fakeKimi({ sessionId: 'session_boot_5' });
  const server = await boot(dir, { cliPath: cli.cliPath });
  const methods = (await import('../core/methods.js')).buildMethods(server.runtime);

  const spawned = await methods.spawnAgentConversation!({ title: 'Kimi' } as never) as
    { conversation: { id: string }; sessionId: string };
  const before = cli.invocations().length;

  // Chris clicks around the app — several focus changes, no messages.
  for (const ref of ['a', 'b', 'c']) {
    await methods.publishFocus!({ app: 'messaging', ref: { kind: 'conversation', id: ref } } as never);
  }
  await server.runtime.kimiRuntime.drain(spawned.sessionId);

  assert.equal(cli.invocations().length, before,
    'a print-mode CLI session must not be prompted (and billed) for a focus change');
  assert.deepEqual(await methods.getFocus!(undefined as never),
    { app: 'messaging', ref: { kind: 'conversation', id: 'c' } }, 'focus is still tracked for pull');
  await server.close();
});

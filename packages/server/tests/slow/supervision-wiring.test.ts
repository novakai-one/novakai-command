// B1b slice 6 — supervision wired into the REAL server (§8 + §10 exit line
// "a supervised session passes the skills gate, gets a cheap-first drift check,
// and is terminated + restarted after a task — every step traced").
//
// This suite boots the actual composition root against a temp `.novakai/` and a
// fake codex CLI, then drives the supervision engine and the WS methods the way
// an operator would. Nothing here is stubbed except the provider executable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { mintClientOpId, queryTraceBound } from '@novakai/foundation/dist/contract/index.js';
import { composeEngine } from '@novakai/foundation/dist/contract/compose.js';
import { canonicalDataRoot } from '../../core/store-paths.js';
import { bootServer, type NovakaiServer } from '../../core/boot.js';
import { openConfigStore } from '../../contract/index.js';

const root = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nvk-supervision-'));
  mkdirSync(path.join(dir, '.git')); // codex wants a git-repo cwd
  return dir;
};

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

/**
 * A fake codex whose reply is read from a control file, so one running server
 * can be made to answer differently turn by turn — which is what a gate test
 * needs (pass, then work) and a drift test needs (silence, then a status line).
 */
function scriptedCodex(dir: string): {
  cliPath: string;
  say(text: string): void;
  silence(): void;
  invocations(): string[][];
} {
  const cliPath = path.join(dir, 'codex-fake');
  const replyFile = path.join(dir, 'reply.txt');
  const invocationFile = path.join(dir, 'codex-invocations.jsonl');
  writeFileSync(replyFile, 'ok');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(invocationFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const reply = fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8');
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread_fake' }) + '\\n');
if (reply !== '__SILENCE__') {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 5 } }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath,
    say: (text: string) => writeFileSync(replyFile, text),
    silence: () => writeFileSync(replyFile, '__SILENCE__'),
    invocations: () => existsSync(invocationFile)
      ? readFileSync(invocationFile, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
      : [],
  };
}

async function boot(dir: string, cliPath: string): Promise<NovakaiServer> {
  const res = await bootServer({
    root: dir, port: 0, cwd: dir, watchdogDir: dir,
    codexCliPath: cliPath,
    providerHome: mkdtempSync(path.join(tmpdir(), 'nvk-provider-home-')),
    supervisionTimers: false, // driven explicitly here, not by wall clock
  });
  if (!res.ok) throw new Error(`boot failed: ${res.error.code} ${res.error.message}`);
  return res.value;
}

/** Every system.action trace the server wrote, newest last. */
async function traces(dir: string): Promise<Array<Record<string, unknown>>> {
  const engine = composeEngine({
    root: dir,
    dataRoot: canonicalDataRoot(dir),
    capability: 'server',
    allowedKinds: ['providerSession'],
    principal: 'sys_spine',
  });
  const page = await queryTraceBound(engine, {});
  return page.items as unknown as Array<Record<string, unknown>>;
}

const supervisionEvents = (lines: Array<Record<string, unknown>>): string[] =>
  lines
    .map((line) => (line.meta as { event?: string } | undefined)?.event)
    .filter((event): event is string => typeof event === 'string');

const connect = (server: NovakaiServer): Promise<WebSocket> => new Promise((resolve, reject) => {
  const ws = new WebSocket(
    `${server.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(server.token)}`,
  );
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
});

const rpc = (
  ws: WebSocket,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> => new Promise((resolve) => {
  ws.on('message', function handler(raw) {
    const frame = JSON.parse(String(raw)) as Record<string, unknown>;
    if (frame.type === 'event' || frame.id !== id) return;
    ws.off('message', handler);
    resolve(frame);
  });
  ws.send(JSON.stringify({ id, method, params, v: 1 }));
});

async function spawnCodexConversation(server: NovakaiServer): Promise<{ sessionId: string; conversationId: string }> {
  const methods = (server.runtime as unknown as { __methods?: never });
  void methods;
  const res = await (await import('../../core/methods.js')).buildMethods(server.runtime)
    .spawnAgentConversation({ title: 'Supervised', provider: 'codex' } as never) as
    { ok: boolean; sessionId?: string; conversation?: { id: string }; error?: string };
  assert.equal(res.ok, true, `spawn failed: ${res.error}`);
  return { sessionId: res.sessionId!, conversationId: res.conversation!.id };
}

test('boot binds all three provider CLIs and reports each one measured, not declared', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const step4 = server.steps.find((s) => s.step === 4)!;
    assert.match(step4.detail, /kimi=/);
    assert.match(step4.detail, /codex=/);
    assert.match(step4.detail, /claude=/);
    assert.match(step4.detail, new RegExp(codex.cliPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'the codex CLI actually bound is named in the boot line');

    const methods = (await import('../../core/methods.js')).buildMethods(server.runtime);
    const caps = await methods.getCapabilities(undefined as never) as
      { providers: Record<string, boolean> };
    assert.equal(caps.providers.codex, true, 'the fake CLI exists on disk, so codex reports available');
    assert.equal(caps.providers.claude, typeof caps.providers.claude === 'boolean' ? caps.providers.claude : false,
      'claude availability is measured from disk, whatever this machine has');
  } finally {
    await server.close();
  }
});

test('step 11 reports usage cadence and confirms drift checks are not scheduled', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const supervision = server.steps.find((step) =>
      step.name === 'supervision')!;
    assert.equal(supervision.step, 11);
    assert.match(supervision.detail, /usage every 300s/);
    assert.match(supervision.detail, /drift checks are explicit only/);
    assert.doesNotMatch(supervision.detail, /drift every/);
    assert.match(supervision.detail, /usage\.jsonl/);
  } finally {
    await server.close();
  }
});

test('a supervised session passes the gate, then gets the work turn (§10 exit line)', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId } = await spawnCodexConversation(server);
    codex.say('SKILLS-CONFIRMED: tdd, elite-codebase-engineering');

    const gate = await server.supervision.runSupervisedTask({
      sessionId, agentId: (await server.sessions.get(sessionId))!.agentId,
      brief: 'Port the widget.',
    });

    assert.equal(gate.ok, true, `gate failed: ${gate.ok ? '' : gate.reason}`);
    if (!gate.ok) return;
    assert.deepEqual(gate.confirmed, ['tdd', 'elite-codebase-engineering']);
    const events = supervisionEvents(await traces(dir));
    assert.ok(events.includes('supervision.gate.pass'), 'the pass is on the trace journal');
    assert.ok(events.includes('supervision.work'), 'so is the work turn');
  } finally {
    await server.close();
  }
});

test('WS runSupervisedTask defines, spawns, gates, and sends work with one traced client operation', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  const ws = await connect(server);
  try {
    codex.say('SKILLS-CONFIRMED: tdd');
    const clientOpId = `op_${crypto.randomUUID()}`;
    const frame = await rpc(ws, 41, 'runSupervisedTask', {
      clientOpId,
      agentDef: { displayName: 'WS Supervised', provider: 'codex', model: 'cli-default' },
      taskBrief: 'Build the WS widget.',
      providerOpts: { model: 'cli-default', cwd: dir },
    });

    assert.equal(frame.error, undefined);
    const result = frame.result as { ok: boolean; sessionId: string; confirmed?: string[] };
    assert.equal(result.ok, true);
    assert.deepEqual(result.confirmed, ['tdd']);
    assert.equal(codex.invocations().length, 2, 'turn 1 gates; turn 2 receives the work');
    assert.doesNotMatch(codex.invocations()[0]!.at(-1)!, /Build the WS widget/);
    assert.match(codex.invocations()[1]!.at(-1)!, /Build the WS widget/);

    const operationTraces = (await traces(dir)).filter((line) => line.clientOpId === clientOpId);
    assert.deepEqual(supervisionEvents(operationTraces), [
      'supervision.gate.pass', 'supervision.work',
    ], 'the caller operation id links the gate and work traces');
    assert.equal((await server.sessions.get(result.sessionId))?.status, 'running');
  } finally {
    ws.close();
    await server.close();
  }
});

test('WS runSupervisedTask terminates an invalid gate without sending the work turn', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  const ws = await connect(server);
  try {
    const defined = await server.runtime.agents.defineAgent(
      { displayName: 'Existing WS Agent', provider: 'codex', model: 'cli-default' },
      `op_${crypto.randomUUID()}` as never,
    );
    assert.equal(defined.ok, true);
    if (!defined.ok) return;
    codex.say('ready without the required marker');
    const clientOpId = `op_${crypto.randomUUID()}`;
    const frame = await rpc(ws, 42, 'runSupervisedTask', {
      clientOpId,
      agentId: defined.value.id,
      taskBrief: 'This work must never be sent.',
      providerOpts: { cwd: dir },
    });

    assert.equal(frame.error, undefined);
    const result = frame.result as { ok: boolean; sessionId: string; reason?: string };
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-marker');
    assert.equal(codex.invocations().length, 1, 'an invalid marker spends only the gate turn');
    assert.doesNotMatch(codex.invocations()[0]!.at(-1)!, /This work must never be sent/);
    assert.equal((await server.sessions.get(result.sessionId))?.status, 'closed');

    const events = supervisionEvents(
      (await traces(dir)).filter((line) => line.clientOpId === clientOpId),
    );
    assert.ok(events.includes('supervision.gate.fail'));
    assert.ok(events.includes('supervision.drift'));
    assert.ok(events.includes('session.terminate'));
  } finally {
    ws.close();
    await server.close();
  }
});

test('a session that fails the gate is terminated, traced, and never gets the brief', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId } = await spawnCodexConversation(server);
    codex.say('Skills are applied, starting now!');

    const gate = await server.supervision.runSupervisedTask({
      sessionId, agentId: (await server.sessions.get(sessionId))!.agentId,
      brief: 'Port the widget.',
    });

    assert.equal(gate.ok, false);
    assert.equal((await server.sessions.get(sessionId))!.status, 'closed',
      'the registry records the termination, not just the process');
    const events = supervisionEvents(await traces(dir));
    assert.ok(events.includes('supervision.gate.fail'));
    assert.ok(events.includes('supervision.drift'));
  } finally {
    await server.close();
  }
});

test('a live session costs zero provider turns to drift-check (SR-1, through the real server)', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId } = await spawnCodexConversation(server);
    const before = (await server.sessions.get(sessionId))!.turns;

    const report = await server.supervision.checkDrift();

    assert.equal(report.providerTurnsSpent, 0);
    assert.equal(report.rows.find((r) => r.sessionId === sessionId)?.live, true);
    assert.equal((await server.sessions.get(sessionId))!.turns, before,
      'the provider turn counter did not move — no money was spent to ask if it was alive');
  } finally {
    await server.close();
  }
});

test('restartSession resumes the original provider thread on the next invocation and traces that truth', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId, conversationId } = await spawnCodexConversation(server);
    // Learn the provider conversation id the way a real turn would.
    codex.say('hello');
    await server.runtime.agents.sendToSession(sessionId as never, 'warm up');
    await server.runtime.providerRuntimes.codex!.drain(sessionId);

    const methods = (await import('../../core/methods.js')).buildMethods(server.runtime);
    const res = await methods.restartSession({ sessionId } as never) as
      { ok: boolean; sessionId?: string; error?: unknown };

    assert.equal(res.ok, true, `restart failed: ${JSON.stringify(res.error)}`);
    assert.notEqual(res.sessionId, sessionId, 'a restart is a NEW session');
    assert.equal((await server.sessions.get(sessionId))!.status, 'closed');
    const fresh = (await server.sessions.get(res.sessionId!))!;
    assert.equal(fresh.status, 'running');
    assert.equal(fresh.providerConversationId, 'thread_fake',
      'restart CARRIES the provider conversation — the work continues');
    assert.equal(server.runtime.conversations.get(conversationId)!.sessionId, res.sessionId,
      'the conversation follows its session, or the thread would look alive while sends went nowhere');
    codex.say('continued');
    await server.runtime.agents.sendToSession(res.sessionId! as never, 'after restart');
    await server.runtime.providerRuntimes.codex!.drain(res.sessionId!);
    assert.deepEqual(codex.invocations()[1], [
      'exec', 'resume', '--json', 'thread_fake', 'after restart',
    ], 'the first post-restart turn resumes the original provider conversation');

    const restartTrace = (await traces(dir)).find(
      (line) => (line.meta as { event?: string } | undefined)?.event === 'supervision.restart',
    );
    assert.ok(restartTrace);
    assert.equal((restartTrace!.meta as { resumed?: boolean }).resumed, true,
      'the trace states what the provider invocation actually did');
    assert.equal((restartTrace!.meta as { resumedFrom?: string }).resumedFrom, 'thread_fake');
  } finally {
    await server.close();
  }
});

test('compactSession drops the context and names restart-fresh as the mechanism', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId } = await spawnCodexConversation(server);
    codex.say('hello');
    await server.runtime.agents.sendToSession(sessionId as never, 'warm up');
    await server.runtime.providerRuntimes.codex!.drain(sessionId);

    const methods = (await import('../../core/methods.js')).buildMethods(server.runtime);
    const res = await methods.compactSession({ sessionId } as never) as
      { ok: boolean; sessionId?: string; mechanism?: string };

    assert.equal(res.ok, true);
    assert.equal(res.mechanism, 'restart-fresh');
    assert.equal((await server.sessions.get(res.sessionId!))!.providerConversationId, null,
      'dropping the context IS the compact where no provider declares a native one');
    assert.ok(supervisionEvents(await traces(dir)).includes('supervision.compact'));
  } finally {
    await server.close();
  }
});

test('getUsageTable returns registry truth plus a stated accounting basis', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    const { sessionId } = await spawnCodexConversation(server);
    const methods = (await import('../../core/methods.js')).buildMethods(server.runtime);
    const table = await methods.getUsageTable(undefined as never) as
      { rows: Array<Record<string, unknown>>; tokenAccounting: string };

    const row = table.rows.find((r) => r.sessionId === sessionId)!;
    assert.equal(row.provider, 'codex');
    assert.equal(row.status, 'running');
    assert.match(table.tokenAccounting, /cumulative/,
      'the codex calibration is stated on the table itself, not buried in a commit');
    assert.match(String(row.note), /transcript|conversation id/i,
      'a null count always says why it is null');
  } finally {
    await server.close();
  }
});

test('emitUsage appends to .novakai/supervision/usage.jsonl and broadcasts the usage event', async () => {
  const dir = root();
  await mintChris(dir);
  const codex = scriptedCodex(dir);
  const server = await boot(dir, codex.cliPath);
  try {
    await spawnCodexConversation(server);
    const broadcasts: string[] = [];
    const previous = server.runtime.broadcast;
    server.runtime.broadcast = (name, data) => { broadcasts.push(name); previous(name, data); };

    await server.supervision.emitUsage();

    const logPath = path.join(dir, 'supervision', 'usage.jsonl');
    assert.ok(existsSync(logPath), 'the server is the SOLE writer of this file (§11 ownership map)');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as { at: string; rows: unknown[] };
    assert.equal(entry.rows.length, 1);
    assert.ok(broadcasts.includes('usage'), 'the shell is fed by the `usage` WS event');
    assert.ok(supervisionEvents(await traces(dir)).includes('supervision.usage'));
  } finally {
    await server.close();
  }
});

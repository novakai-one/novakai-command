// B1a — reattach after a server restart (DEC-B1-6, §13 disposition 2).
//
// "attach() post-restart = rebind the registry handle; the next send spawns a
// fresh process with the provider resume id (nothing live to attach to)."
// Without this the logical session is orphaned: the registry remembers it, but
// no adapter or runtime knows it, so a send silently goes nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeAgents, createAgentsContract, createKimiCliRuntime } from '../contract/index.js';

function fakeKimi(): { cliPath: string; invocations(): string[][] } {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-kimi-reattach-'));
  const cliPath = path.join(dir, 'kimi');
  const logPath = path.join(dir, 'invocations.log');
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ role: 'assistant', content: 'reattached reply' }) + '\\n');
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath,
    invocations: () => (existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []),
  };
}

test('a restarted process reattaches a persisted session and resumes the CLI conversation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-reattach-'));
  const cli = fakeKimi();

  // ── the process that spawned the session is gone; only the registry record
  //    survived. Rebuild everything from that record.
  const runtime = createKimiCliRuntime({ cwd: root, cliPath: cli.cliPath });
  const ctx = composeAgents({ root, principal: 'person_chris', providerRuntimes: { kimi: runtime }, allowMock: false, cwd: root });
  const agents = createAgentsContract(ctx);
  const defined = await agents.defineAgent(
    { displayName: 'Kimi', provider: 'kimi', model: 'cli-default' }, `op_${crypto.randomUUID()}` as never,
  );
  assert.equal(defined.ok, true);
  if (!defined.ok) return;

  const reattached = agents.reattachSession({
    sessionId: 'sess_from_registry',
    agentId: defined.value.id,
    provider: 'kimi',
    providerConversationId: 'session_cli_survivor',
    model: 'cli-default',
    cwd: root,
  });
  assert.equal(reattached, true);

  // attach() answers for it, and a send reaches the provider WITH the resume id.
  const sent = await agents.sendToSession('sess_from_registry' as never, 'after the restart');
  assert.equal(sent, true, 'a reattached session accepts sends');
  await runtime.drain('sess_from_registry');

  const argv = cli.invocations();
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0], ['-p', 'after the restart', '--output-format', 'stream-json', '-S', 'session_cli_survivor']);
});

test('reattaching an unknown provider is refused, not silently accepted', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-reattach-2-'));
  const ctx = composeAgents({ root, principal: 'person_chris', providerRuntimes: {}, allowMock: false, cwd: root });
  const agents = createAgentsContract(ctx);
  assert.equal(agents.reattachSession({
    sessionId: 'sess_x', agentId: 'agent_x', provider: 'claude',
    providerConversationId: null, model: 'cli-default', cwd: root,
  }), false, 'no runtime for claude yet (B1b) — the session cannot be rebound');
});

test('output from a reattached session remains transcript-only content', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-reattach-3-'));
  const cli = fakeKimi();
  const runtime = createKimiCliRuntime({ cwd: root, cliPath: cli.cliPath });
  const ctx = composeAgents({ root, principal: 'person_chris', providerRuntimes: { kimi: runtime }, allowMock: false, cwd: root });
  const agents = createAgentsContract(ctx);
  const defined = await agents.defineAgent(
    { displayName: 'Kimi', provider: 'kimi', model: 'cli-default' }, `op_${crypto.randomUUID()}` as never,
  );
  if (!defined.ok) return;

  agents.reattachSession({
    sessionId: 'sess_lane', agentId: defined.value.id, provider: 'kimi',
    providerConversationId: 'session_lane', model: 'cli-default', cwd: root,
  });

  const posted: string[] = [];
  agents.attachLiveLane({
    sessionId: 'sess_lane' as never,
    address: 'person:person_chris',
    sender: {
      async sendMessage(input: unknown) {
        posted.push((input as { body: { text: string } }).body.text);
        return { kind: 'ok', value: { threadId: 't', messageId: 'm' } } as never;
      },
    },
  });

  await agents.sendToSession('sess_lane' as never, 'ping');
  await runtime.drain('sess_lane');
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(posted, []);
});

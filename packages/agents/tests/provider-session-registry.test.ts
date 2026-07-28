// B1a slice 4 — the providerSession registry (DEC-B1-6, §13 dispositions 2/10).
// agents owns the kind and is its sole writer. Sessions are RESUMABLE HANDLES,
// never durable identity (red gate A-7 / B1 red gate 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeAgents } from '../contract/index.js';
import { createProviderSessionRegistry, type ProcessProbe } from '../core/sessions/registry.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-provider-sessions-'));
const openRegistry = (dir: string, probe?: ProcessProbe) =>
  createProviderSessionRegistry(composeAgents({ root: dir, principal: 'person_chris', allowMock: false }), probe);

const deadProbe: ProcessProbe = { alive: () => false, startedAt: () => null };

test('a spawned session is registered with its resumable handle and survives a restart', async () => {
  const dir = root();
  const first = openRegistry(dir);
  const created = await first.register({
    sessionId: 'sess_1', agentId: 'agent_1', provider: 'kimi',
    cwd: '/repo', model: 'cli-default',
  });
  assert.equal(created.ok, true);

  // The CLI conversation id is learned AFTER the first reply — it is recorded then.
  const learned = await first.recordResumeHandle('sess_1', 'session_cli_abc');
  assert.equal(learned.ok, true);

  // "Restart": a brand new registry over the same root.
  const second = openRegistry(dir);
  const listed = await second.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.sessionId, 'sess_1');
  assert.equal(listed[0]!.providerConversationId, 'session_cli_abc');
  assert.equal(listed[0]!.status, 'running');
  assert.equal(listed[0]!.provider, 'kimi');
  assert.equal(listed[0]!.turns, 0);
});

test('send marks inFlight generating; reply completion clears it and counts the turn', async () => {
  const dir = root();
  const registry = openRegistry(dir);
  await registry.register({ sessionId: 'sess_2', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });

  await registry.markSending('sess_2', { clientOpId: 'op_send_1', pid: 4242, pidStartedAt: 'Mon Jul 28 10:00:00 2026' });
  const sending = await registry.get('sess_2');
  assert.equal(sending?.inFlight.status, 'generating');
  assert.equal(sending?.inFlight.clientOpId, 'op_send_1');

  await registry.markReplied('sess_2');
  const replied = await registry.get('sess_2');
  assert.equal(replied?.inFlight.status, 'none');
  assert.equal(replied?.turns, 1);
  assert.notEqual(replied?.lastActivityAt, replied?.spawnedAt);
});

test('crash with a reply in flight → ReplyInterrupted on boot, surfaced once, NEVER auto-retried', async () => {
  const dir = root();
  const crashed = openRegistry(dir);
  await crashed.register({ sessionId: 'sess_3', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });
  await crashed.markSending('sess_3', { clientOpId: 'op_send_9', pid: 4242, pidStartedAt: 'Mon Jul 28 10:00:00 2026' });
  // ...server dies here...

  const rebooted = openRegistry(dir, deadProbe);
  const swept = await rebooted.sweepOrphans();
  assert.equal(swept.interrupted.length, 1);
  assert.deepEqual(swept.interrupted[0], {
    sessionId: 'sess_3', clientOpId: 'op_send_9', reason: 'ReplyInterrupted',
  });
  assert.equal(swept.killed.length, 0, 'the orphan pid was already gone');

  const after = await rebooted.get('sess_3');
  assert.equal(after?.inFlight.status, 'none', 'nothing is left generating');
  assert.equal(after?.lastInterruption?.clientOpId, 'op_send_9',
    'the interruption is recorded so the thread can offer "resend?" with the SAME clientOpId');
  assert.equal(after?.status, 'running', 'the logical session is still resumable');

  // Idempotent: booting again must not re-surface an interruption nobody retried.
  const swept2 = await openRegistry(dir, deadProbe).sweepOrphans();
  assert.deepEqual(swept2.interrupted, []);
});

test('the sweep only kills a pid whose START TIME matches the record (§13 disposition 10)', async () => {
  const dir = root();
  const seed = openRegistry(dir);
  await seed.register({ sessionId: 'sess_4', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });
  await seed.markSending('sess_4', { clientOpId: 'op_x', pid: 777, pidStartedAt: 'Mon Jul 28 10:00:00 2026' });

  const killed: number[] = [];
  const recycledPid: ProcessProbe = {
    alive: () => true,
    startedAt: () => 'Tue Jul 28 23:59:00 2026', // a DIFFERENT process now owns pid 777
    kill: (pid: number) => { killed.push(pid); },
  };
  const swept = await openRegistry(dir, recycledPid).sweepOrphans();
  assert.equal(killed.length, 0, 'a recycled pid is never killed');
  assert.deepEqual(swept.killed, []);
  assert.equal(swept.interrupted.length, 1, 'the interruption is still surfaced');

  const dir2 = root();
  const seed2 = openRegistry(dir2);
  await seed2.register({ sessionId: 'sess_5', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });
  await seed2.markSending('sess_5', { clientOpId: 'op_y', pid: 888, pidStartedAt: 'Mon Jul 28 10:00:00 2026' });
  const ourOrphan: ProcessProbe = {
    alive: () => true,
    startedAt: () => 'Mon Jul 28 10:00:00 2026', // same process we spawned
    kill: (pid: number) => { killed.push(pid); },
  };
  const swept2 = await openRegistry(dir2, ourOrphan).sweepOrphans();
  assert.deepEqual(killed, [888], 'our own orphaned child IS reaped');
  assert.deepEqual(swept2.killed, [888]);
});

test('closing a session records it as closed and it stops being resumable', async () => {
  const dir = root();
  const registry = openRegistry(dir);
  await registry.register({ sessionId: 'sess_6', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });
  await registry.close('sess_6', 'closed');

  const closed = await registry.get('sess_6');
  assert.equal(closed?.status, 'closed');
  assert.deepEqual(await registry.resumable(), [], 'a closed session is not offered for attach');
});

test('setModel on a live session is recorded so a restart resumes on the same model', async () => {
  const dir = root();
  const registry = openRegistry(dir);
  await registry.register({ sessionId: 'sess_7', agentId: 'a', provider: 'kimi', cwd: '/repo', model: 'cli-default' });
  await registry.recordModel('sess_7', 'k2-turbo');
  assert.equal((await openRegistry(dir).get('sess_7'))?.model, 'k2-turbo');
});

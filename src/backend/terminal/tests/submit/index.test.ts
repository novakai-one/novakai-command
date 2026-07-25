// Submission-lane serialization (correction C2, audit S2): jobs run the FULL
// type→settle→submit→flush lifecycle per agent, in order — two sends inside
// the settle window can never merge. Exercises the DELAYED lifecycle with
// real timers, not job-order bookkeeping. Run with
// `npx tsx src/backend/terminal/tests/submit/index.test.ts`.
// NEVER call the real launcher here — the fake below records writes.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalManager } from '../../manager.js';
import type { ProviderLauncher } from '../../provider/index.js';

interface RecordedWrite {
  data: string;
  atMs: number;
}

function makeManager(): { manager: TerminalManager; writes: RecordedWrite[] } {
  const startedAt = Date.now();
  const writes: RecordedWrite[] = [];
  const launcher: ProviderLauncher = () => ({
    process: {
      'pid': 4242,
      write: (data: string) => { writes.push({ data, atMs: Date.now() - startedAt }); },
      resize: () => {},
      kill: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
    },
    sessionId: new Promise<string>(() => {}), // never resolves — irrelevant here
    cancelSessionWait: () => {},
  });
  const registryPath = join(mkdtempSync(join(tmpdir(), 'mc-submit-')), 'agents.json');
  return { manager: new TerminalManager(registryPath, launcher), writes };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// --- two sends inside the settle window stay whole and ordered ---------------

{
  const { manager, writes } = makeManager();
  const info = await manager.create({ cwd: '/tmp/fake' });
  assert.equal(manager.submit({ agentId: info.agentId, messageId: 'm1', text: 'first message', settleMs: 60 }), true);
  await sleep(10); // well inside m1's settle window
  assert.equal(manager.submit({ agentId: info.agentId, messageId: 'm2', text: 'second message', settleMs: 60 }), true);
  await sleep(250);
  assert.deepEqual(
    writes.map((entry) => entry.data),
    ['first message', '\r', 'second message', '\r'],
    'job 2 text never writes before job 1 submits — bodies land whole, in order',
  );
  console.log('settle-window serialization test passed');
}

// --- the flush leg is part of the serialized lifecycle -----------------------

{
  const { manager, writes } = makeManager();
  const info = await manager.create({ cwd: '/tmp/fake' });
  manager.submit({ agentId: info.agentId, messageId: 'k1', text: 'kimi one', settleMs: 30, flushMs: 90 });
  await sleep(5);
  manager.submit({ agentId: info.agentId, messageId: 'k2', text: 'kimi two', settleMs: 30, flushMs: 90 });
  await sleep(350);
  assert.deepEqual(
    writes.map((entry) => entry.data),
    ['kimi one', '\r', '\r', 'kimi two', '\r', '\r'],
    'job 2 waits for job 1 to flush; no bare \\r ever lands on job 2 mid-settle',
  );
  console.log('flush-lifecycle serialization test passed');
}

// --- lanes are per agent: different PTYs do not queue on each other ----------

{
  const { manager, writes } = makeManager();
  const first = await manager.create({ cwd: '/tmp/fake-a' });
  const second = await manager.create({ cwd: '/tmp/fake-b' });
  manager.submit({ agentId: first.agentId, messageId: 'a1', text: 'to-first', settleMs: 80 });
  manager.submit({ agentId: second.agentId, messageId: 'b1', text: 'to-second', settleMs: 10 });
  await sleep(150);
  const order = writes.map((entry) => entry.data);
  assert.ok(order.indexOf('to-second') === 1, 'second agent did not wait behind the first agent\'s settle');
  console.log('per-agent lane independence test passed');
}

// --- duplicate messageIds stay no-ops even through the queue -----------------

{
  const { manager, writes } = makeManager();
  const info = await manager.create({ cwd: '/tmp/fake' });
  manager.submit({ agentId: info.agentId, messageId: 'dup', text: 'once only', settleMs: 10 });
  manager.submit({ agentId: info.agentId, messageId: 'dup', text: 'once only', settleMs: 10 });
  await sleep(80);
  assert.equal(writes.filter((entry) => entry.data === 'once only').length, 1, 'deduped by messageId');
  console.log('queued dedupe test passed');
}

// --- audit #3b: a duplicate messageId against a DEAD lane is refused -------------------
// Liveness is judged BEFORE dedupe: true-against-a-corpse is never reported.

{
  let exitHandler: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const launcher: ProviderLauncher = () => ({
    process: {
      'pid': 4242,
      write: () => {},
      resize: () => {},
      kill: () => {},
      onData: () => ({ dispose: () => {} }),
      onExit: (handler: (event: { exitCode: number; signal?: number }) => void) => {
        exitHandler = handler;
        return { dispose: () => {} };
      },
    },
    sessionId: new Promise<string>(() => {}),
    cancelSessionWait: () => {},
  });
  const registryPath = join(mkdtempSync(join(tmpdir(), 'mc-submit-dead-')), 'agents.json');
  const manager = new TerminalManager(registryPath, launcher);
  const info = await manager.create({ cwd: '/tmp/fake-dead' });
  assert.equal(manager.submit({ agentId: info.agentId, messageId: 'dead-1', text: 'first', settleMs: 30 }), true);
  exitHandler?.({ exitCode: 0 });
  assert.equal(
    manager.submit({ agentId: info.agentId, messageId: 'dead-1', text: 'first', settleMs: 30 }),
    false,
    'duplicate messageId against a dead lane is refused (presence-gone), never true-against-a-corpse',
  );
  console.log('corpse-dedupe refusal test passed');
}

console.log('PASS');

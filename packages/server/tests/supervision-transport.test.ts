// B1b disposal M5 — concurrent supervision asks on one logical provider
// session must remain isolated. Provider output names only the session, so the
// transport correlates it to ask ids by provider turn order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisedTransport } from '../core/supervision/transport.js';
import type {
  ProviderCliRuntime,
  ProviderTurnRecord,
} from '../../agents/contract/index.js';

function fakeRuntime() {
  const dataCallbacks: Array<(key: string, data: string) => void> = [];
  const turnCallbacks: Array<(record: ProviderTurnRecord) => void> = [];
  const drainResolvers: Array<() => void> = [];
  const runtime = {
    onData(callback: (key: string, data: string) => void) {
      dataCallbacks.push(callback);
    },
    onTurn(callback: (record: ProviderTurnRecord) => void) {
      turnCallbacks.push(callback);
    },
    drain: async () => new Promise<void>((resolve) => drainResolvers.push(resolve)),
  } as unknown as ProviderCliRuntime;

  return {
    runtime,
    finish(key: string, text: string) {
      for (const callback of dataCallbacks) callback(key, text);
      const record: ProviderTurnRecord = {
        key,
        cliSessionId: 'thread_1',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        exitCode: 0,
        model: null,
        usage: null,
      };
      for (const callback of turnCallbacks) callback(record);
      drainResolvers.shift()?.();
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('two overlapping asks on one session keep their streamed replies isolated', async () => {
  const fake = fakeRuntime();
  let sends = 0;
  const transport = createSupervisedTransport({
    agents: { sendToSession: async () => { sends += 1; return true; } },
    runtimes: { codex: fake.runtime },
    providerOf: async () => 'codex',
    timeoutMs: 1_000,
  });

  const first = transport.ask('sess_1', 'first');
  const second = transport.ask('sess_1', 'second');
  while (sends < 2) await settle();

  fake.finish('sess_1', 'first-answer');
  assert.deepEqual(await first, { ok: true, text: 'first-answer' });
  fake.finish('sess_1', 'second-answer');
  assert.deepEqual(await second, { ok: true, text: 'second-answer' });
});

test('a timed-out ask discards its late chunks without corrupting the next ask', async () => {
  const fake = fakeRuntime();
  let sends = 0;
  const transport = createSupervisedTransport({
    agents: { sendToSession: async () => { sends += 1; return true; } },
    runtimes: { codex: fake.runtime },
    providerOf: async () => 'codex',
  });

  const timedOut = transport.ask('sess_1', 'slow', { timeoutMs: 10 });
  const next = transport.ask('sess_1', 'next', { timeoutMs: 1_000 });
  while (sends < 2) await settle();
  assert.deepEqual(await timedOut, { ok: false, reason: 'timeout', text: '' });

  fake.finish('sess_1', 'late-slow-answer');
  fake.finish('sess_1', 'next-answer');
  assert.deepEqual(await next, { ok: true, text: 'next-answer' });
});

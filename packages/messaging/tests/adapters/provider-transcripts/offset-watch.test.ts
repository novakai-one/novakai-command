import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMemoryTranscriptStore,
  createMessagingRuntime,
  createProviderTranscriptSource,
  providerNormalizer,
  type AgentDirectory,
  type ProviderTranscriptSource,
  type TranscriptStore,
} from '../../../contract/index.js';

const AGENT_ID = 'agent_offset-watch';
const SESSION_ID = 'provider-offset-watch';
const NOW = '2026-08-28T00:00:00.000Z';

const normalizers = {
  claude: providerNormalizer('claude'),
  codex: providerNormalizer('codex'),
  kimi: providerNormalizer('kimi'),
} as const;

const agentDirectory: AgentDirectory = {
  async get(agentId) {
    return agentId === AGENT_ID
      ? { agentId, provider: 'claude', currentProviderSessionId: null }
      : null;
  },
  async ensureForSession() {
    return { ok: false, code: 'NotExpected', message: 'identity marker owns assignment' };
  },
  async deliveryReadiness() { return 'idle'; },
  async attachProviderSession() { return { ok: true, state: 'attached' }; },
};

const markerRow = (): string => JSON.stringify({
  type: 'system',
  subtype: 'hook_response',
  sessionId: SESSION_ID,
  message: {
    role: 'system',
    content: [{
      type: 'hook_result',
      content: JSON.stringify({
        kind: 'novakai-agent-identity',
        schemaVersion: 1,
        hookEvent: 'UserPromptSubmit',
        agentId: AGENT_ID,
      }),
    }],
  },
});

const assistantRow = (id: string, text: string): string => JSON.stringify({
  type: 'assistant',
  uuid: id,
  sessionId: SESSION_ID,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const initialTranscript = (text: string): string =>
  `${markerRow()}\n${assistantRow('line-initial', text)}\n`;

const sourceFor = (root: string): ProviderTranscriptSource =>
  createProviderTranscriptSource({ claude: [root] });

const withoutWatchEvents = (source: ProviderTranscriptSource): ProviderTranscriptSource => ({
  scan: () => source.scan(),
  statKnown: (sourceIds) => source.statKnown!(sourceIds),
  watchChanges: async () => ({ close() {} }),
  readGrowth: (stat, checkpoint) => source.readGrowth(stat, checkpoint),
});

const runtimeFor = (
  store: TranscriptStore,
  source: ProviderTranscriptSource,
  safetySweepMs = 60_000,
) => createMessagingRuntime({
  store,
  source,
  normalizers,
  agentDirectory,
  now: () => NOW,
  intervalMs: 60_000,
  safetySweepMs,
  changeDebounceMs: 1,
});

async function assistantTexts(store: TranscriptStore): Promise<readonly string[]> {
  return (await store.listTranscriptLines())
    .filter((line) => line.role === 'assistant')
    .map((line) => line.text);
}

async function waitForTexts(
  store: TranscriptStore,
  expected: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (JSON.stringify(await assistantTexts(store)) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await assistantTexts(store), expected);
}

test('restart catches known-file growth exactly once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvk-offset-restart-'));
  const file = path.join(root, 'session.jsonl');
  await writeFile(file, initialTranscript('before'));
  const store = createMemoryTranscriptStore();
  const first = runtimeFor(store, sourceFor(root));
  await first.start();
  await first.stop();
  await appendFile(file, `${assistantRow('line-after-restart', 'after')}\n`);

  const restarted = runtimeFor(store, sourceFor(root));
  try {
    await restarted.start();
    await restarted.ingestNow();
    assert.deepEqual(await assistantTexts(store), ['before', 'after']);
  } finally {
    await restarted.stop();
  }
});

test('boot discovers a new file created while stopped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvk-offset-new-offline-'));
  await writeFile(path.join(root, 'session.jsonl'), initialTranscript('offline'));
  const store = createMemoryTranscriptStore();
  const runtime = runtimeFor(store, sourceFor(root));
  try {
    await runtime.start();
    assert.deepEqual(await assistantTexts(store), ['offline']);
  } finally {
    await runtime.stop();
  }
});

test('safety sweep recovers a suppressed append event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvk-offset-lost-append-'));
  const file = path.join(root, 'session.jsonl');
  await writeFile(file, initialTranscript('before'));
  const store = createMemoryTranscriptStore();
  const runtime = runtimeFor(store, withoutWatchEvents(sourceFor(root)), 5);
  try {
    await runtime.start();
    await appendFile(file, `${assistantRow('line-lost-append', 'recovered')}\n`);
    await waitForTexts(store, ['before', 'recovered']);
  } finally {
    await runtime.stop();
  }
});

test('safety sweep discovers a suppressed new-file event', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvk-offset-lost-create-'));
  await mkdir(root, { recursive: true });
  const store = createMemoryTranscriptStore();
  const runtime = runtimeFor(store, withoutWatchEvents(sourceFor(root)), 5);
  try {
    await runtime.start();
    await writeFile(path.join(root, 'session.jsonl'), initialTranscript('discovered'));
    await waitForTexts(store, ['discovered']);
  } finally {
    await runtime.stop();
  }
});

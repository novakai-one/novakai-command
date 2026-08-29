import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMessagingRuntime } from '../../core/ingestion/messaging-runtime.js';
import { createMemoryTranscriptStore } from '../../adapters/stores/memory.js';
import { openFoundationTranscriptStore } from '../../adapters/stores/jsonl.js';
import { messageCorrelationHint } from '../../contract/correlation.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { ProviderTranscriptSource } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';

const emptySource: ProviderTranscriptSource = {
  scan: async () => [],
  readGrowth: async () => { throw new Error('no source'); },
};

const normalizers = {
  claude: { provider: 'claude', normalize: () => { throw new Error('no line'); } },
  codex: { provider: 'codex', normalize: () => { throw new Error('no line'); } },
  kimi: { provider: 'kimi', normalize: () => { throw new Error('no line'); } },
} as const;

function directory() {
  let sessionId: ProviderSessionId | null = null;
  const value: AgentDirectory = {
    async get(agentId) {
      return agentId === 'agent_alpha'
        ? { agentId, provider: 'claude', currentProviderSessionId: sessionId }
        : null;
    },
    async ensureForSession() {
      return { ok: false, code: 'NotExpected', message: 'send proof does not adopt' };
    },
    async deliveryReadiness() { return 'idle'; },
    async attachProviderSession(_agentId, providerSessionId) {
      sessionId = providerSessionId as ProviderSessionId;
      return { ok: true, state: 'attached' };
    },
  };
  return { value, attach: (next: string) => { sessionId = next as ProviderSessionId; } };
}

const sendInput = {
  conversationId: 'conv_alpha',
  issuedBy: 'person_chris',
  targetAgentId: 'agent_alpha',
  text: 'hello',
  clientOpId: 'client-op-1',
};

test('acceptance is durable before one provider effect and confirms only from transcript', async () => {
  const store = createMemoryTranscriptStore();
  const agents = directory();
  let effects = 0;
  const providerSend: ProviderSend = {
    async dispatch() {
      effects += 1;
      const journals = await store.listSendJournals();
      assert.equal(journals[0]?.state, 'dispatching');
      return {
        ok: true,
        dispatchedAt: '2026-08-25T00:00:01.000Z' as Timestamp,
        certainty: 'unconfirmed',
        response: '',
      };
    },
  };
  let tick = 0;
  const runtime = createMessagingRuntime({
    store,
    source: emptySource,
    normalizers,
    agentDirectory: agents.value,
    providerSend,
    now: () => `2026-08-25T00:00:0${tick++}.000Z`,
  });

  const [first, replay] = await Promise.all([
    runtime.sendConversationMessage(sendInput),
    runtime.sendConversationMessage(sendInput),
  ]);
  assert.equal(first.kind, 'ok');
  assert.equal(replay.kind, 'ok');
  assert.equal(effects, 1, 'concurrent equal acceptance claims one effect');
  assert.equal((await store.listSendJournals())[0]?.state, 'awaiting-session-assignment');

  const sessionId = `sess_${'1'.repeat(8)}-${'1'.repeat(4)}-1111-8111-${'1'.repeat(12)}` as never;
  agents.attach(sessionId);
  assert.equal(await store.bindAgentSession(
    'agent_alpha',
    sessionId,
    '2026-08-25T00:00:04.000Z',
  ), 1);
  assert.equal((await store.listSendJournals())[0]?.state, 'awaiting-transcript');

  const line: TranscriptLine = {
    id: `transcriptLine_${'a'.repeat(64)}` as never,
    kind: 'transcript-line',
    schemaVersion: 1,
    createdAt: '2026-08-25T00:00:05.000Z' as never,
    sessionId,
    provider: 'claude',
    sourcePosition: {
      sourceId: `source_${'b'.repeat(64)}` as never,
      sourceEpoch: 0,
      offset: 1,
      nextOffset: 2,
    },
    turnIndex: 1,
    role: 'user',
    text: 'hello',
    correlationHint: messageCorrelationHint('hello'),
    raw: '{}',
  };
  const unrelated: TranscriptLine = {
    ...line,
    id: `transcriptLine_${'c'.repeat(64)}` as never,
    text: 'direct provider input',
    correlationHint: messageCorrelationHint('direct provider input'),
  };
  assert.equal(await store.confirmSendForLines(
    sessionId,
    [unrelated],
    '2026-08-25T00:00:05.500Z',
  ), 0);
  assert.equal((await store.listSendJournals())[0]?.state, 'awaiting-transcript');
  assert.equal(await store.confirmSendForLines(
    sessionId,
    [line],
    '2026-08-25T00:00:06.000Z',
  ), 1);
  const confirmed = (await store.listSendJournals())[0];
  assert.equal(confirmed?.state, 'confirmed');
  assert.equal(confirmed?.attempts[0]?.confirmedLineId, line.id);
});

test('ambiguous close sends become indeterminate instead of taking the wrong user line', async () => {
  const store = createMemoryTranscriptStore();
  const agents = directory();
  const sessionId = `sess_${'2'.repeat(8)}-${'2'.repeat(4)}-4222-8222-${'2'.repeat(12)}` as never;
  agents.attach(sessionId);
  let tick = 0;
  const runtime = createMessagingRuntime({
    store,
    source: emptySource,
    normalizers,
    agentDirectory: agents.value,
    providerSend: {
      dispatch: async () => ({
        ok: true,
        dispatchedAt: `2026-08-25T00:00:0${tick++}.000Z` as Timestamp,
        certainty: 'unconfirmed',
        response: '',
      }),
    },
  });
  await runtime.sendConversationMessage({ ...sendInput, clientOpId: 'close-1' });
  await runtime.sendConversationMessage({ ...sendInput, clientOpId: 'close-2' });
  const lines = [0, 1].map((offset): TranscriptLine => ({
    id: `transcriptLine_${String(offset + 3).repeat(64)}` as never,
    kind: 'transcript-line',
    schemaVersion: 1,
    createdAt: `2026-08-25T00:00:1${offset}.000Z` as never,
    sessionId,
    provider: 'claude',
    sourcePosition: {
      sourceId: `source_${'d'.repeat(64)}` as never,
      sourceEpoch: 0,
      offset,
      nextOffset: offset + 1,
    },
    turnIndex: offset,
    role: 'user',
    text: 'hello',
    correlationHint: messageCorrelationHint('hello'),
    raw: '{}',
  }));
  assert.equal(await store.confirmSendForLines(
    sessionId, lines, '2026-08-25T00:00:20.000Z',
  ), 0);
  const journals = await store.listSendJournals();
  assert.equal(journals.every((journal) => journal.state === 'indeterminate'), true);
  assert.equal(journals.every((journal) =>
    journal.attempts.at(-1)?.failure === 'TranscriptCorrelationAmbiguous'), true);
});

test('a resumed send confirms only beyond its persisted source fence', async () => {
  const store = createMemoryTranscriptStore();
  const agents = directory();
  const sessionId = `sess_${'4'.repeat(8)}-${'4'.repeat(4)}-4444-8444-${'4'.repeat(12)}` as never;
  const sourceId = `source_${'e'.repeat(64)}` as never;
  agents.attach(sessionId);
  await store.commitIngestBatch({
    expectedCheckpoint: null,
    session: {
      id: sessionId, kind: 'provider-session', schemaVersion: 1,
      createdAt: '2026-08-25T00:00:00.000Z' as never,
      provider: 'claude', sourceIds: [sourceId], status: 'idle', agentId: 'agent_alpha',
    },
    lines: [],
    checkpoint: {
      id: `ingestCheckpoint_${'f'.repeat(64)}` as never,
      kind: 'ingest-checkpoint', schemaVersion: 1,
      createdAt: '2026-08-25T00:00:00.000Z' as never,
      updatedAt: '2026-08-25T00:00:00.000Z' as never,
      provider: 'claude', sourceId, sourceEpoch: 0, offset: 100, nextTurnIndex: 1,
      fileSignature: { device: '1', inode: '1', tailHash: 'a'.repeat(64) },
    },
  });
  const runtime = createMessagingRuntime({
    store, source: emptySource, normalizers, agentDirectory: agents.value,
    providerSend: { dispatch: async () => ({
      ok: true, dispatchedAt: '2026-08-25T00:00:01.000Z' as Timestamp, certainty: 'unconfirmed', response: '',
    }) },
  });
  await runtime.sendConversationMessage({ ...sendInput, clientOpId: 'fenced-send' });
  const attempt = (await store.listSendJournals())[0]?.attempts[0];
  assert.deepEqual(attempt?.sourceFence, { sourceId, sourceEpoch: 0, offset: 100 });
  const lineAt = (offset: number): TranscriptLine => ({
    id: `transcriptLine_${String(offset).padStart(64, '0')}` as never,
    kind: 'transcript-line', schemaVersion: 1,
    createdAt: '2026-08-24T00:00:00.000Z' as never,
    sessionId, provider: 'claude',
    sourcePosition: { sourceId, sourceEpoch: 0, offset, nextOffset: offset + 1 },
    turnIndex: 1, role: 'user', text: 'hello',
    correlationHint: messageCorrelationHint('hello'), raw: '{}',
  });
  assert.equal(await store.confirmSendForLines(
    sessionId, [lineAt(99)], '2026-08-25T00:00:02.000Z',
  ), 0);
  assert.equal(await store.confirmSendForLines(
    sessionId, [lineAt(100)], '2026-08-25T00:00:03.000Z',
  ), 1);
});

test('a reused client operation with different content is rejected before effect', async () => {
  const store = createMemoryTranscriptStore();
  const agents = directory();
  let effects = 0;
  const runtime = createMessagingRuntime({
    store,
    source: emptySource,
    normalizers,
    agentDirectory: agents.value,
    providerSend: {
      async dispatch() {
        effects += 1;
        return {
          ok: true,
          dispatchedAt: new Date().toISOString() as Timestamp,
          certainty: 'unconfirmed',
          response: '',
        };
      },
    },
  });
  assert.equal((await runtime.sendConversationMessage(sendInput)).kind, 'ok');
  assert.equal((await runtime.sendConversationMessage({ ...sendInput, text: 'different' })).kind, 'error');
  assert.equal(effects, 1);
});

test('Foundation adapter replays SendJournal state from the canonical database', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvk-send-journal-'));
  const dataRoot = path.join(root, 'stores');
  const store = await openFoundationTranscriptStore({ root, dataRoot });
  const agents = directory();
  const runtime = createMessagingRuntime({
    store,
    source: emptySource,
    normalizers,
    agentDirectory: agents.value,
    providerSend: {
      dispatch: async () => ({
        ok: true,
        dispatchedAt: '2026-08-25T00:00:00.000Z' as Timestamp,
        certainty: 'unconfirmed',
        response: '',
      }),
    },
  });
  assert.equal((await runtime.sendConversationMessage(sendInput)).kind, 'ok');
  await assert.rejects(
    openFoundationTranscriptStore({ root, dataRoot }),
    /messaging-transcript is held by PID/u,
  );
  await store.close();
  const reopened = await openFoundationTranscriptStore({ root, dataRoot });
  const [journal] = await reopened.listSendJournals();
  assert.equal(journal?.clientOpId, sendInput.clientOpId);
  assert.equal(journal?.state, 'awaiting-session-assignment');
  await reopened.close();
});

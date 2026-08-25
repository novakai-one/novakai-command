import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMemoryTranscriptStore,
  createMessagingRuntime,
  openFoundationTranscriptStore,
  type AgentDirectory,
  type ProviderSend,
  type ProviderTranscriptSource,
  type TranscriptLine,
} from '../../contract/index.js';

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
  let sessionId: string | null = null;
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
      sessionId = providerSessionId;
      return { ok: true, state: 'attached' };
    },
  };
  return { value, attach: (next: string) => { sessionId = next; } };
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
        dispatchedAt: '2026-08-25T00:00:01.000Z',
        certainty: 'unconfirmed',
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
    raw: '{}',
  };
  assert.equal(await store.confirmSendForLines(
    sessionId,
    [line],
    '2026-08-25T00:00:06.000Z',
  ), 1);
  const confirmed = (await store.listSendJournals())[0];
  assert.equal(confirmed?.state, 'confirmed');
  assert.equal(confirmed?.attempts[0]?.confirmedLineId, line.id);
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
          dispatchedAt: new Date().toISOString(),
          certainty: 'unconfirmed',
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
        dispatchedAt: '2026-08-25T00:00:00.000Z',
        certainty: 'unconfirmed',
      }),
    },
  });
  assert.equal((await runtime.sendConversationMessage(sendInput)).kind, 'ok');
  await store.close();
  const reopened = await openFoundationTranscriptStore({ root, dataRoot });
  const [journal] = await reopened.listSendJournals();
  assert.equal(journal?.clientOpId, sendInput.clientOpId);
  assert.equal(journal?.state, 'awaiting-session-assignment');
  await reopened.close();
});

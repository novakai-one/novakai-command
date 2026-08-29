import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessagingRuntime } from '../../core/runtime/messaging-runtime.js';
import { createMemoryTranscriptStore } from '../../adapters/stores/memory.js';
import { providerNormalizer } from '../../adapters/provider-transcripts/normalizers/index.js';
import type { ProviderTranscriptSource } from '../../contract/ports/provider-transcript-source.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { RequestHash } from '../../contract/types.js';

const at = '2026-08-26T00:00:00.000Z' as never;
const sourceId = `source_${'a'.repeat(64)}` as never;
const sessionId = `sess_${'b'.repeat(64)}` as never;

const line = (index: number, role: TranscriptLine['role'], raw: object): TranscriptLine => ({
  id: `transcriptLine_${String(index).repeat(64)}` as never,
  kind: 'transcript-line',
  schemaVersion: 1,
  createdAt: at,
  sessionId,
  provider: 'kimi',
  sourcePosition: { sourceId, sourceEpoch: 0, offset: index, nextOffset: index + 1 },
  turnIndex: index,
  role,
  text: '',
  raw: JSON.stringify(raw),
});

test('snapshot and live delivery share one canonical provider projection', async () => {
  const store = createMemoryTranscriptStore();
  const runtime = createMessagingRuntime({
    store,
    source: {
      scan: async () => [],
      readGrowth: async () => { throw new Error('no source'); },
    } satisfies ProviderTranscriptSource,
    normalizers: {
      claude: providerNormalizer('claude'),
      codex: providerNormalizer('codex'),
      kimi: providerNormalizer('kimi'),
    },
  });
  const wrapper = line(1, 'user', { input: [{ type: 'text', text: 'internal wrapper' }] });
  const visibleUser = line(2, 'user', {
    message: {
      role: 'user',
      origin: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    },
  });
  const reply = line(3, 'assistant', {
    message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
  });
  const session: ProviderSession = {
    id: sessionId,
    kind: 'provider-session',
    schemaVersion: 1,
    createdAt: at,
    provider: 'kimi',
    sourceIds: [sourceId],
    status: 'idle',
    agentId: 'agent_kimi',
  };
  const journal: SendJournal = {
    id: `send_${'c'.repeat(64)}` as never,
    kind: 'send-journal',
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    conversationId: 'conv_kimi' as never,
    issuedBy: 'person_chris',
    targetAgentId: 'agent_kimi',
    targetSessionId: sessionId,
    clientOpId: 'op_kimi',
    request: { text: 'hello' },
    requestHash: 'hash' as RequestHash,
    state: 'confirmed',
    attempts: [{
      attemptId: `sendAttempt_${'d'.repeat(64)}` as never,
      state: 'confirmed',
      dispatchedAt: at,
      confirmedLineId: wrapper.id,
    }],
  };
  const checkpoint: IngestCheckpoint = {
    id: `ingestCheckpoint_${'e'.repeat(64)}` as never,
    kind: 'ingest-checkpoint',
    schemaVersion: 1,
    createdAt: at,
    updatedAt: at,
    provider: 'kimi',
    sourceId,
    sourceEpoch: 0,
    offset: 4,
    nextTurnIndex: 4,
    fileSignature: { device: '1', inode: '2', tailHash: 'tail' },
  };

  await store.acceptSend({ journal });
  const live: unknown[] = [];
  runtime.subscribeAgentConversationMessages((event) => { live.push(event.message); });
  await store.commitIngestBatch({
    expectedCheckpoint: null,
    session,
    lines: [wrapper, visibleUser, reply],
    checkpoint,
  });
  await runtime.eventBus.pump();
  const snapshot = await runtime.listAgentConversationMessages({ agentId: 'agent_kimi' });

  assert.equal(snapshot.kind, 'ok');
  if (snapshot.kind !== 'ok') return;
  assert.deepEqual(live, snapshot.value);
  assert.deepEqual(snapshot.value.map(({ role, text, clientOpId }) =>
    [role, text, clientOpId]), [
    ['user', 'hello', 'op_kimi'],
    ['assistant', 'world', undefined],
  ]);
});

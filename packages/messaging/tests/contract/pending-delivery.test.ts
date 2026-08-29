import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMessagingRuntime } from '../../core/runtime/messaging-runtime.js';
import { createMemoryTranscriptStore } from '../../adapters/stores/memory.js';
import { openFoundationTranscriptStore } from '../../adapters/stores/jsonl.js';
import { messageCorrelationHint } from '../../contract/correlation.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { DeliveryFailure, PendingDelivery } from '../../contract/records/pending-delivery.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { PendingDeliveryState } from '../../contract/types.js';

const emptySource = {
  scan: async () => [],
  readGrowth: async () => { throw new Error('no provider growth'); },
};
const normalizers = {
  claude: { provider: 'claude', normalize: () => { throw new Error('unused'); } },
  codex: { provider: 'codex', normalize: () => { throw new Error('unused'); } },
  kimi: { provider: 'kimi', normalize: () => { throw new Error('unused'); } },
} as const;
const timestamp = '2026-08-26T00:00:00.000Z' as Timestamp;

const session = (id: string, agentId: string, sourceId: string): ProviderSession => ({
  id: id as never,
  kind: 'provider-session',
  schemaVersion: 1,
  createdAt: timestamp as never,
  provider: 'claude',
  sourceIds: [sourceId as never],
  status: 'idle',
  agentId,
  resumeId: id as never,
});

async function appendLine(
  store: TranscriptStore,
  owner: ProviderSession,
  key: string,
  role: TranscriptLine['role'],
  text: string,
  sourceKey = key,
): Promise<TranscriptLine> {
  const sourceId = `source_${sourceKey.repeat(64).slice(0, 64)}` as never;
  const prior = await store.getCheckpoint(sourceId);
  const offset = prior?.offset ?? 0;
  const line: TranscriptLine = {
    id: `transcriptLine_${key.repeat(64).slice(0, 64)}` as never,
    kind: 'transcript-line',
    schemaVersion: 1,
    createdAt: timestamp as never,
    sessionId: owner.id,
    provider: owner.provider,
    sourcePosition: { sourceId, sourceEpoch: prior?.sourceEpoch ?? 0, offset, nextOffset: offset + 1 },
    turnIndex: 0,
    role,
    text,
    ...(role === 'user' ? { correlationHint: messageCorrelationHint(text) } : {}),
    raw: JSON.stringify({ role, text }),
  };
  await store.commitIngestBatch({
    expectedCheckpoint: prior,
    session: { ...owner, sourceIds: [...owner.sourceIds, sourceId] },
    lines: [line],
    checkpoint: {
      id: prior?.id ?? `checkpoint_${sourceKey.repeat(64).slice(0, 64)}` as never,
      kind: 'ingest-checkpoint',
      schemaVersion: 1,
      createdAt: timestamp as never,
      updatedAt: timestamp as never,
      provider: owner.provider,
      sourceId,
      sourceEpoch: prior?.sourceEpoch ?? 0,
      offset: offset + 1,
      nextTurnIndex: (prior?.nextTurnIndex ?? 0) + 1,
      fileSignature: { device: '1', inode: sourceKey, tailHash: key.repeat(64).slice(0, 64) },
    },
  });
  return line;
}

function deliveryMarker(recipientAgentId: string, text: string, key: string): string {
  const payload = Buffer.from(JSON.stringify({
    version: 1, recipientAgentId, text, clientOpId: key,
  }), 'utf8').toString('base64url');
  return `NOVAKAI_DELIVERY_V1:${payload}`;
}

/** Typed failure evidence used wherever a test needs a failed delivery. */
const proofFailure: DeliveryFailure = { kind: 'dispatch-failed', detail: 'proof' };

function dependencies(store: TranscriptStore) {
  const current = new Map<string, string | null>([
    ['agent_alpha', 'session_alpha'],
    ['agent_bravo', 'session_bravo'],
    ['agent_unassigned', null],
  ]);
  const readiness = new Map<string, 'idle' | 'busy'>([
    ['agent_alpha', 'idle'],
    ['agent_bravo', 'busy'],
    ['agent_unassigned', 'idle'],
  ]);
  const pairs: string[] = [];
  let effects = 0;
  const agents: AgentDirectory = {
    async get(agentId) {
      if (!current.has(agentId)) return null;
      return {
        agentId,
        provider: 'claude',
        currentProviderSessionId: current.get(agentId)! as ProviderSessionId | null,
      };
    },
    async deliveryReadiness(agentId) { return readiness.get(agentId) ?? 'unavailable'; },
    async ensureForSession() { return { ok: false, code: 'unused', message: 'unused' }; },
    async attachProviderSession() { return { ok: false, code: 'unused', message: 'unused' }; },
  };
  const conversations: ConversationDirectory = {
    async ensureForAdoptedAgent() { return { conversationId: 'conv_adopted' }; },
    async ensureForAgentPair(input) {
      pairs.push(input.participantAgentIds.join(':'));
      return { conversationId: 'conv_pair-ab' };
    },
  };
  const providerSend: ProviderSend = {
    async dispatch() {
      effects += 1;
      return { ok: true, dispatchedAt: timestamp, certainty: 'unconfirmed', response: '' };
    },
  };
  const runtime = () => createMessagingRuntime({
    store, source: emptySource, normalizers,
    agentDirectory: agents, conversations, providerSend, now: () => timestamp,
  });
  return {
    runtime,
    pairs,
    effects: () => effects,
    setIdle: (agentId: string) => { readiness.set(agentId, 'idle'); },
  };
}

test('addressed transcript work waits for idle, reuses the pair View and never retries uncertainty', async () => {
  const store = createMemoryTranscriptStore();
  const alpha = session('session_alpha', 'agent_alpha', `source_${'a'.repeat(64)}`);
  const bravo = session('session_bravo', 'agent_bravo', `source_${'b'.repeat(64)}`);
  await store.upsertProviderSession(bravo);
  await appendLine(store, alpha, 'c', 'tool_result',
    deliveryMarker('agent_bravo', 'alpha to bravo', 'op-ab'));
  const fixture = dependencies(store);

  const busy = await fixture.runtime().routePending();
  assert.equal(busy.kind === 'ok' && busy.value.deferredBusy, 1);
  assert.equal(fixture.effects(), 0);
  assert.equal((await store.listPendingDeliveries())[0]?.state, 'queued');

  fixture.setIdle('agent_bravo');
  await appendLine(store, bravo, 'd', 'tool_result',
    deliveryMarker('agent_alpha', 'bravo to alpha', 'op-ba'));
  assert.equal((await fixture.runtime().routePending()).kind, 'ok');
  assert.equal(fixture.effects(), 2);
  assert.deepEqual(new Set(fixture.pairs), new Set(['agent_alpha:agent_bravo']));
  assert.ok((await store.listPendingDeliveries())
    .every((item) => item.state === 'submitted-unconfirmed'));
  const communications = await fixture.runtime().listAgentCommunications({
    agentIds: ['agent_alpha', 'agent_bravo'], limit: 20,
  });
  assert.equal(communications.kind === 'ok' && communications.value.items.length, 2);
  if (communications.kind === 'ok') {
    assert.equal(new Set(communications.value.items.map((item) => item.conversationGroupingKey)).size, 1);
    assert.ok(communications.value.items.every((item) =>
      item.deliveryState === 'submitted-unconfirmed' && item.direction === 'from-agent'));
  }

  assert.equal((await fixture.runtime().routePending()).kind, 'ok');
  assert.equal(fixture.effects(), 2, 'unconfirmed work is never retried after runtime recovery');
  const journal = (await store.listSendJournals())
    .find((candidate) => candidate.targetSessionId === bravo.id);
  const confirmation = await appendLine(store, bravo, 'e', 'user', journal!.request.text, 'd');
  assert.equal(await store.confirmSendForLines(bravo.id, [confirmation], timestamp), 1);
  await fixture.runtime().routePending();
  assert.equal((await store.listPendingDeliveries())
    .filter((item) => item.state === 'transcript-observed').length, 1);
});

test('unassigned recipients remain queued without a provider effect', async () => {
  const store = createMemoryTranscriptStore();
  const alpha = session('session_alpha', 'agent_alpha', `source_${'a'.repeat(64)}`);
  await appendLine(store, alpha, 'f', 'tool_result',
    deliveryMarker('agent_unassigned', 'wait for a session', 'op-wait'));
  const fixture = dependencies(store);
  await fixture.runtime().routePending();
  assert.equal(fixture.effects(), 0);
  assert.equal((await store.listPendingDeliveries())[0]?.state, 'queued');
});

const delivery = (key: string): PendingDelivery => ({
  id: `pendingDelivery_${key.repeat(64).slice(0, 64)}` as never,
  kind: 'pending-delivery',
  schemaVersion: 1,
  createdAt: timestamp as never,
  updatedAt: timestamp as never,
  transcriptLineId: `transcriptLine_${key.repeat(64).slice(0, 64)}` as never,
  recipientAgentId: 'agent_bravo',
  state: 'queued',
});

test('every PendingDelivery state survives restart and illegal skips are refused', async () => {
  const targets: readonly PendingDeliveryState[] = [
    'queued', 'claimed', 'submitted-confirmed', 'submitted-unconfirmed',
    'transcript-observed', 'failed',
  ];
  for (const [index, target] of targets.entries()) {
    const root = await mkdtemp(path.join(tmpdir(), `nvk-delivery-${target}-`));
    const options = { root, dataRoot: path.join(root, 'stores') };
    const store = await openFoundationTranscriptStore(options);
    const item = delivery(String.fromCharCode(103 + index));
    await store.acceptPendingDelivery({ delivery: item });
    if (target !== 'queued') {
      const first = target === 'failed' ? 'failed' : 'claimed';
      await store.transitionPendingDelivery({
        id: item.id, expectedState: 'queued', state: first,
        updatedAt: timestamp,
        ...(first === 'failed' ? { failure: proofFailure } : {}),
      });
      if (target.startsWith('submitted')) {
        await store.transitionPendingDelivery({
          id: item.id, expectedState: 'claimed', state: target, updatedAt: timestamp,
        });
      } else if (target === 'transcript-observed') {
        await store.transitionPendingDelivery({
          id: item.id, expectedState: 'claimed', state: 'submitted-confirmed', updatedAt: timestamp,
        });
        await store.transitionPendingDelivery({
          id: item.id, expectedState: 'submitted-confirmed', state: target, updatedAt: timestamp,
        });
      }
    }
    await store.close();
    const reopened = await openFoundationTranscriptStore(options);
    const restored = (await reopened.listPendingDeliveries())[0];
    assert.equal(restored?.state, target);
    if (target === 'failed') assert.deepEqual(restored?.failure, proofFailure);
    await reopened.close();
  }

  const store = createMemoryTranscriptStore();
  const item = delivery('z');
  await store.acceptPendingDelivery({ delivery: item });
  await assert.rejects(store.transitionPendingDelivery({
    id: item.id,
    expectedState: 'queued',
    state: 'transcript-observed',
    updatedAt: timestamp,
  }), /cannot move/);
});

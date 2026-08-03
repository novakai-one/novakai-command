import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId,
  mintTraceCorrelationId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  composeProviderUsageEvidence,
  type ProviderUsageEvidence,
  type RecordProviderUsageEvidenceInput,
} from '../contract/index.js';

const SESSION_ID = 'sess_123e4567-e89b-42d3-a456-426614174000' as never;

function systemContext(): SystemCommandContext<'sys_agents'> {
  return {
    principal: { id: 'sys_agents', kind: 'system', verifiedScopes: [] },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const INPUT: RecordProviderUsageEvidenceInput = {
  providerSessionId: SESSION_ID,
  providerConversationId: 'provider-conversation-1',
  observedAt: '2026-08-03T01:00:00.000Z' as never,
  source: 'provider-turn-completed',
  sourceCursor: 'turn-1',
  measurement: {
    quality: 'measured',
    inputTokens: 125,
    outputTokens: 25,
    cachedInputTokens: 10,
    costMicros: 42_000,
    providerTurns: 1,
    limitations: [],
    evidenceDigest: 'sha256:provider-turn-1',
  },
};

test('Agents records and queries append-only provider usage evidence', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-usage-'));
  try {
    const evidence = composeProviderUsageEvidence({
      root,
      dataRoot: path.join(root, 'stores'),
    });

    const recorded = await evidence.recordProviderUsageEvidence(systemContext(), INPUT);
    assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);
    if (!recorded.ok) return;
    assert.equal(recorded.value.kind, 'providerUsageEvidence');
    assert.match(String(recorded.value.id), /^providerUsage_[a-z2-7]{52}$/u);
    assert.deepEqual(recorded.value.measurement, INPUT.measurement);

    const listed = await evidence.listProviderUsageEvidence(
      { id: 'person_chris' as never, kind: 'human', verifiedScopes: [] },
      SESSION_ID,
    );
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error.message);
    if (!listed.ok) return;
    assert.deepEqual(listed.value.items, [recorded.value]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Agents publishes committed provider usage evidence after the durable append', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-usage-event-'));
  try {
    const published: Array<{
      kind: string;
      payload: ProviderUsageEvidence;
      traceId: string;
      durableAtPublish: boolean;
    }> = [];
    const evidence = composeProviderUsageEvidence({
      root,
      dataRoot: path.join(root, 'stores'),
      publish(kind, payload, traceId) {
        published.push({
          kind,
          payload,
          traceId: String(traceId),
          durableAtPublish: existsSync(path.join(root, 'stores', 'providerUsageEvidence.jsonl')),
        });
      },
    });
    const context = systemContext();

    const recorded = await evidence.recordProviderUsageEvidence(context, INPUT);
    assert.equal(recorded.ok, true, recorded.ok ? '' : recorded.error.message);
    if (!recorded.ok) return;
    assert.deepEqual(published, [{
      kind: 'agent.provider-usage-evidence.committed',
      payload: recorded.value,
      traceId: String(context.traceId),
      durableAtPublish: true,
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Agents rejects unavailable usage carrying an invented numeric value', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-usage-invalid-'));
  try {
    const evidence = composeProviderUsageEvidence({
      root,
      dataRoot: path.join(root, 'stores'),
    });
    const recorded = await evidence.recordProviderUsageEvidence(systemContext(), {
      ...INPUT,
      measurement: {
        quality: 'unavailable',
        inputTokens: 0,
        limitations: ['provider did not report usage'],
        evidenceDigest: 'sha256:unavailable-with-zero',
      },
    });
    assert.equal(recorded.ok, false);
    if (!recorded.ok) assert.equal(recorded.error.code, 'ValidationFailed');
    assert.equal(
      existsSync(path.join(root, 'stores', 'providerUsageEvidence.jsonl')),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Agents replays one provider usage command without a second record or event', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-usage-replay-'));
  try {
    let published = 0;
    const evidence = composeProviderUsageEvidence({
      root,
      dataRoot: path.join(root, 'stores'),
      publish() { published += 1; },
    });
    const context = systemContext();

    const first = await evidence.recordProviderUsageEvidence(context, INPUT);
    const replay = await evidence.recordProviderUsageEvidence(context, INPUT);
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
    if (!first.ok || !replay.ok) return;
    assert.deepEqual(replay.value, first.value);
    const lines = readFileSync(
      path.join(root, 'stores', 'providerUsageEvidence.jsonl'),
      'utf8',
    ).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(published, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same deterministic evidence is idempotent across different commands', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-usage-deterministic-'));
  try {
    let published = 0;
    const evidence = composeProviderUsageEvidence({
      root,
      dataRoot: path.join(root, 'stores'),
      publish() { published += 1; },
    });

    const first = await evidence.recordProviderUsageEvidence(systemContext(), INPUT);
    const second = await evidence.recordProviderUsageEvidence(systemContext(), INPUT);
    assert.equal(first.ok, true, first.ok ? '' : first.error.message);
    assert.equal(second.ok, true, second.ok ? '' : second.error.message);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(second.value, first.value);
    const lines = readFileSync(
      path.join(root, 'stores', 'providerUsageEvidence.jsonl'),
      'utf8',
    ).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(published, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

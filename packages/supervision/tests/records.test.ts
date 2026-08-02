import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgentRunUsage,
  parseCreateWatchRuleInput,
} from '../contract/index.js';

test('activity-drift accepts the exact cheap-first template at the 5-minute default', () => {
  const parsed = parseCreateWatchRuleInput({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' },
    condition: {
      kind: 'activity-drift', intervalMs: 300_000,
      staleAfterIntervals: 2, escalateAfterConsecutive: 3,
    },
    recipient: { kind: 'human', principalId: 'human_chris' },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    driftPolicy: {
      mode: 'cheap-first',
      freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      replyWindowMs: 300_000,
      statusPrompt: 'Status check: reply with one line — what are you working on right now?',
    },
  });

  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  if (!parsed.ok) return;
  assert.equal(parsed.value.condition.kind, 'activity-drift');
  assert.deepEqual(parsed.value.driftPolicy?.freeEvidence, [
    'terminal-liveness', 'transcript-advance', 'usage-delta',
  ]);
});

test('usage truth preserves unavailable evidence without inventing a zero', () => {
  const unavailable = {
    quality: 'unavailable',
    source: 'provider-no-metering',
    limitations: ['provider did not expose usage'],
  };
  const parsed = parseAgentRunUsage({
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab',
    inputTokens: unavailable,
    outputTokens: unavailable,
    cachedInputTokens: unavailable,
    costMicros: unavailable,
    providerTurns: unavailable,
    observedAt: '2026-08-02T00:00:00.000Z',
    final: false,
  });

  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  if (!parsed.ok) return;
  assert.equal(parsed.value.inputTokens.value, undefined);
  assert.equal(parsed.value.providerTurns.value, undefined);
});

test('out-of-range drift timing returns the spec-named WatchRuleInvalid code', () => {
  const parsed = parseCreateWatchRuleInput({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' },
    condition: {
      kind: 'activity-drift', intervalMs: 299_999,
      staleAfterIntervals: 2, escalateAfterConsecutive: 3,
    },
    recipient: { kind: 'human', principalId: 'human_chris' },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    driftPolicy: {
      mode: 'cheap-first',
      freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      replyWindowMs: 300_000,
      statusPrompt: 'Status check: reply with one line — what are you working on right now?',
    },
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, 'WatchRuleInvalid');
});

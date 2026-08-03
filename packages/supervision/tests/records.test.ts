import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgentRunUsage,
  parseCreateWatchRuleInput,
  isRunDisconnectedEdge,
  canTransitionNotificationState,
} from '../contract/index.js';

test('activity-drift accepts the exact cheap-first template at the 5-minute default', () => {
  const parsed = parseCreateWatchRuleInput({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' },
    condition: {
      kind: 'activity-drift', intervalMs: 300_000,
      staleAfterIntervals: 2, escalateAfterConsecutive: 3,
    },
    recipient: { kind: 'human', principalId: 'person_chris' },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    driftPolicy: {
      mode: 'cheap-first',
      freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      statusRecipient: 'subject-agent',
      statusDeliveryMode: 'start-turn',
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
  assert.equal(parsed.value.driftPolicy?.statusRecipient, 'subject-agent');
  assert.equal(parsed.value.driftPolicy?.statusDeliveryMode, 'start-turn');
});

test('Notification state transitions reject shortcuts and terminal rewrites', () => {
  assert.equal(canTransitionNotificationState('queued', 'offered-to-endpoint'), true);
  assert.equal(canTransitionNotificationState('queued', 'delivery-uncertain'), true);
  assert.equal(canTransitionNotificationState('offered-to-endpoint', 'transcript-observed'), true);
  assert.equal(canTransitionNotificationState('transcript-observed', 'acknowledged'), true);
  assert.equal(canTransitionNotificationState('queued', 'acknowledged'), false);
  assert.equal(canTransitionNotificationState('acknowledged', 'queued'), false);
  assert.equal(canTransitionNotificationState('expired', 'queued'), false);
});

test('human watcher recipients use the existing Messaging PersonId identity', () => {
  const parsed = parseCreateWatchRuleInput({
    subject: { kind: 'agent-run', agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' },
    condition: { kind: 'run-final' },
    recipient: { kind: 'human', principalId: 'human_chris' },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
  });
  assert.equal(parsed.ok, false);
});

test('run-disconnected observes only a new provider-liveness uncertainty generation', () => {
  const connected = {
    activity: 'idle' as const,
    activityGeneration: 4 as never,
    uncertaintyCodes: [] as const,
    observedAt: '2026-08-02T00:00:04.000Z' as never,
  };
  assert.equal(isRunDisconnectedEdge(connected, {
    activity: 'unknown',
    activityGeneration: 5 as never,
    uncertaintyCodes: ['provider-liveness-unknown'],
    observedAt: '2026-08-02T00:00:05.000Z' as never,
  }), true);
  assert.equal(isRunDisconnectedEdge(connected, {
    activity: 'idle',
    activityGeneration: 5 as never,
    uncertaintyCodes: ['provider-liveness-unknown'],
    observedAt: '2026-08-02T00:00:05.000Z' as never,
  }), false);
  assert.equal(isRunDisconnectedEdge(connected, { ...connected }), false);
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
    recipient: { kind: 'human', principalId: 'person_chris' },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    driftPolicy: {
      mode: 'cheap-first',
      freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
      statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
      statusRecipient: 'subject-agent',
      statusDeliveryMode: 'start-turn',
      replyWindowMs: 300_000,
      statusPrompt: 'Status check: reply with one line — what are you working on right now?',
    },
  });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.code, 'WatchRuleInvalid');
});

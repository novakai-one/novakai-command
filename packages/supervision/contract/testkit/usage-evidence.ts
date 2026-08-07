import assert from 'node:assert/strict';
import { deriveNotificationId, subjectKey } from '../index.js';
import type {
  NotificationId,
  ProviderUsageEvidenceCommittedEvent,
  ProviderUsageMeasurement,
} from '../index.js';
import { parseProviderUsageEvidenceCommittedEvent } from '../event-validation.js';

/** Provider half of the Agents usage-evidence → Supervision watcher seam. */
export interface UsageEvidenceProviderHarness {
  emitUsageEvidence(
    measurement: ProviderUsageMeasurement,
    revision?: number,
  ): Promise<ProviderUsageEvidenceCommittedEvent>;
}

/** Observable consumer result; test adapters map real watcher behavior into this view. */
export interface UsageWatcherObservation {
  readonly consumedEventId: string;
  readonly providerTurnsStarted: number;
  readonly emittedNotificationIds: readonly NotificationId[];
  readonly usageFingerprintChanged: boolean;
  readonly outputTokensQuality: ProviderUsageMeasurement['quality'];
  readonly observedOutputTokens?: number;
}

/** Consumer half of the Agents usage-evidence → Supervision watcher seam. */
export interface UsageEvidenceWatcherConsumerHarness {
  evaluateUsageEvent(
    event: ProviderUsageEvidenceCommittedEvent,
  ): Promise<UsageWatcherObservation>;
}

const THRESHOLD_MEASUREMENT: ProviderUsageMeasurement = {
  quality: 'measured',
  inputTokens: 50_000,
  outputTokens: 100_000,
  cachedInputTokens: 10_000,
  costMicros: 2_500_000,
  providerTurns: 100,
  limitations: [],
  evidenceDigest: 'sha256:usage-100k',
};

const EXPECTED_NOTIFICATION_ID = deriveNotificationId({
  watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
  subjectKey: subjectKey({
    kind: 'agent',
    agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
  }),
  condition: { kind: 'output-tokens-at-least', value: 100_000 },
  activityGeneration: 1 as never,
  phase: 'condition',
});

/** Verify that an Agents-side provider does not rewrite requested usage truth. */
export async function assertUsageEvidenceProviderContract(
  provider: UsageEvidenceProviderHarness,
): Promise<void> {
  const event = await provider.emitUsageEvidence(THRESHOLD_MEASUREMENT);
  const parsed = parseProviderUsageEvidenceCommittedEvent(event);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  assert.equal(event.kind, 'agent.provider-usage-evidence.committed');
  assert.equal(event.sourceOwner, 'agents');
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.payload.kind, 'providerUsageEvidence');
  assert.deepEqual(event.payload.measurement, THRESHOLD_MEASUREMENT);
}

/** Verify replay-safe threshold evaluation and the no-model-polling law. */
export async function assertUsageEvidenceWatcherConsumerContract(
  provider: UsageEvidenceProviderHarness,
  consumer: UsageEvidenceWatcherConsumerHarness,
): Promise<void> {
  const event = await provider.emitUsageEvidence(THRESHOLD_MEASUREMENT);
  const first = await consumer.evaluateUsageEvent(event);
  const replay = await consumer.evaluateUsageEvent(event);
  assert.equal(first.consumedEventId, event.eventId);
  assert.equal(replay.consumedEventId, event.eventId);
  assert.equal(first.providerTurnsStarted, 0);
  assert.equal(replay.providerTurnsStarted, 0);
  assert.deepEqual(first.emittedNotificationIds, [EXPECTED_NOTIFICATION_ID]);
  assert.equal(replay.emittedNotificationIds.length, 0);

  const equivalentNewEvent = await provider.emitUsageEvidence(THRESHOLD_MEASUREMENT, 2);
  const equivalent = await consumer.evaluateUsageEvent(equivalentNewEvent);
  assert.notEqual(equivalent.consumedEventId, event.eventId);
  assert.equal(equivalent.usageFingerprintChanged, false);
  assert.equal(equivalent.emittedNotificationIds.length, 0);

  const belowThreshold = await consumer.evaluateUsageEvent(
    await provider.emitUsageEvidence({
      ...THRESHOLD_MEASUREMENT,
      outputTokens: 99_999,
      evidenceDigest: 'sha256:usage-below-100k',
    }, 3),
  );
  assert.equal(belowThreshold.emittedNotificationIds.length, 0);

  const unavailable = await consumer.evaluateUsageEvent(
    await provider.emitUsageEvidence({
      quality: 'unavailable',
      limitations: ['provider did not expose output-token totals'],
      evidenceDigest: 'sha256:usage-unavailable',
    }, 4),
  );
  assert.equal(unavailable.outputTokensQuality, 'unavailable');
  assert.equal(unavailable.observedOutputTokens, undefined);
  assert.equal(unavailable.emittedNotificationIds.length, 0);
}

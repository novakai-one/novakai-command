import assert from 'node:assert/strict';
import type {
  NotificationId,
  ProviderUsageEvidenceCommittedEvent,
  ProviderUsageMeasurement,
} from '../index.js';

/** Provider half of the Agents usage-evidence → Supervision watcher seam. */
export interface UsageEvidenceProviderHarness {
  emitUsageEvidence(
    measurement: ProviderUsageMeasurement,
  ): Promise<ProviderUsageEvidenceCommittedEvent>;
}

/** Observable consumer result; test adapters map real watcher behavior into this view. */
export interface UsageWatcherObservation {
  readonly consumedEventId: string;
  readonly providerTurnsStarted: number;
  readonly emittedNotificationIds: readonly NotificationId[];
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

/** Verify that an Agents-side provider does not rewrite requested usage truth. */
export async function assertUsageEvidenceProviderContract(
  provider: UsageEvidenceProviderHarness,
): Promise<void> {
  const event = await provider.emitUsageEvidence(THRESHOLD_MEASUREMENT);
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
  assert.equal(first.emittedNotificationIds.length, 1);
  assert.equal(replay.emittedNotificationIds.length, 0);
}

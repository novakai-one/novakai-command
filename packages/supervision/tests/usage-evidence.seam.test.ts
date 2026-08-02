import test from 'node:test';
import {
  assertUsageEvidenceProviderContract,
  assertUsageEvidenceWatcherConsumerContract,
  type UsageEvidenceProviderHarness,
  type UsageEvidenceWatcherConsumerHarness,
} from '../contract/testkit/index.js';
import { deriveNotificationId, subjectKey } from '../contract/index.js';
import type { ProviderUsageEvidence } from '../contract/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const provider: UsageEvidenceProviderHarness = {
  emitUsageEvidence: async (measurement, revision) => usageEvidenceEvent(measurement, revision),
};

test('usage-evidence provider preserves the authoritative measurement event', async () => {
  await assertUsageEvidenceProviderContract(provider);
});

test('watcher consumer fires once under replay without starting a provider turn', async () => {
  const seen = new Set<string>();
  const seenFingerprints = new Set<string>();
  const notificationId = deriveNotificationId({
    watchRuleId: 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    subjectKey: subjectKey({
      kind: 'agent',
      agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
    }),
    condition: { kind: 'output-tokens-at-least', value: 100_000 },
    activityGeneration: 1 as never,
    phase: 'condition',
  });
  const consumer: UsageEvidenceWatcherConsumerHarness = {
    evaluateUsageEvent: async (event) => {
      const firstDelivery = !seen.has(event.eventId);
      seen.add(event.eventId);
      const evidence = event.payload as unknown as ProviderUsageEvidence;
      const fingerprint = JSON.stringify(evidence.measurement);
      const usageFingerprintChanged = !seenFingerprints.has(fingerprint);
      seenFingerprints.add(fingerprint);
      const thresholdSatisfied = evidence.measurement.outputTokens !== undefined
        && evidence.measurement.outputTokens >= 100_000
        && evidence.measurement.quality !== 'unavailable';
      return {
        consumedEventId: event.eventId,
        providerTurnsStarted: 0,
        emittedNotificationIds: firstDelivery && usageFingerprintChanged && thresholdSatisfied
          ? [notificationId]
          : [],
        usageFingerprintChanged,
        outputTokensQuality: evidence.measurement.quality,
        ...(evidence.measurement.outputTokens === undefined
          ? {}
          : { observedOutputTokens: evidence.measurement.outputTokens }),
      };
    },
  };
  await assertUsageEvidenceWatcherConsumerContract(provider, consumer);
});

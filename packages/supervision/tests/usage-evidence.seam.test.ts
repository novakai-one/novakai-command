import test from 'node:test';
import {
  assertUsageEvidenceProviderContract,
  assertUsageEvidenceWatcherConsumerContract,
  type UsageEvidenceProviderHarness,
  type UsageEvidenceWatcherConsumerHarness,
} from '../contract/testkit/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const provider: UsageEvidenceProviderHarness = {
  emitUsageEvidence: async (measurement) => usageEvidenceEvent(measurement),
};

test('usage-evidence provider preserves the authoritative measurement event', async () => {
  await assertUsageEvidenceProviderContract(provider);
});

test('watcher consumer fires once under replay without starting a provider turn', async () => {
  const seen = new Set<string>();
  const consumer: UsageEvidenceWatcherConsumerHarness = {
    evaluateUsageEvent: async (event) => {
      const firstDelivery = !seen.has(event.eventId);
      seen.add(event.eventId);
      return {
        consumedEventId: event.eventId,
        providerTurnsStarted: 0,
        emittedNotificationIds: firstDelivery
          ? [`notification_${'b'.repeat(52)}` as never]
          : [],
      };
    },
  };
  await assertUsageEvidenceWatcherConsumerContract(provider, consumer);
});

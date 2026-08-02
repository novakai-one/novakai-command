import test from 'node:test';
import { b3err, b3fail, b3ok } from '@novakai/foundation/contract';
import {
  assertSafeBoundaryConsumerContract,
  assertSafeBoundaryRuntimeProviderContract,
  assertSubmittedUnconfirmedNeverRetries,
  type RuntimeSafeBoundaryProviderHarness,
  type SafeBoundaryConsumerHarness,
  type SafeBoundaryFacts,
  type SubmittedDriftStatus,
} from '../contract/testkit/index.js';
import { queuedDriftStatusTurn } from './fixtures.js';

const provider: RuntimeSafeBoundaryProviderHarness = {
  submitStatusTurn: async ({ expectedDeadlineRecordVersion, status }) => {
    if (Number(expectedDeadlineRecordVersion) !== 4) {
      return b3fail(b3err(
        'WatcherConflict',
        'deadline record version changed',
        { expectedDeadlineRecordVersion, actualDeadlineRecordVersion: 4 },
        true,
      ));
    }
    return b3ok({
    providerEffectsStarted: 1,
    status: {
      episodeId: status.episodeId,
      effectKey: status.effectKey,
      notificationId: status.notificationId,
      state: 'submitted-confirmed',
      requestedAt: status.requestedAt,
      submittedAt: '2026-08-02T00:03:00.000Z' as never,
      replyDueAt: '2026-08-02T00:08:00.000Z' as never,
      notificationInputReservationId: `notificationInput_${'f'.repeat(52)}` as never,
      terminalInputAttemptId: 'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    },
    });
  },
};

test('Runtime provider preserves the queued drift episode across safe submission', async () => {
  await assertSafeBoundaryRuntimeProviderContract(provider, queuedDriftStatusTurn());
});

test('Runtime provider never retries a submitted-unconfirmed status turn', async () => {
  let providerEffectsStarted = 0;
  const recovered = new Map<string, SubmittedDriftStatus>();
  const uncertainProvider: RuntimeSafeBoundaryProviderHarness = {
    submitStatusTurn: async ({ status }) => {
      const previous = recovered.get(status.effectKey);
      if (previous !== undefined) {
        return b3ok({ providerEffectsStarted, status: previous });
      }
      providerEffectsStarted += 1;
      const submitted: SubmittedDriftStatus = {
          episodeId: status.episodeId,
          effectKey: status.effectKey,
          notificationId: status.notificationId,
          state: 'submitted-unconfirmed',
          requestedAt: status.requestedAt,
          submittedAt: '2026-08-02T00:03:00.000Z' as never,
          replyDueAt: '2026-08-02T00:08:00.000Z' as never,
          notificationInputReservationId: `notificationInput_${'f'.repeat(52)}` as never,
          terminalInputAttemptId: 'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
      };
      recovered.set(status.effectKey, submitted);
      return b3ok({ providerEffectsStarted, status: submitted });
    },
  };
  await assertSubmittedUnconfirmedNeverRetries(
    uncertainProvider,
    queuedDriftStatusTurn(),
  );
});

test('consumer waits for a safe boundary and deduplicates the effect key', async () => {
  const submitted = new Map<string, SubmittedDriftStatus>();
  let providerCalls = 0;
  const consumer: SafeBoundaryConsumerHarness = {
    offerStatusTurn: async (request, boundary: SafeBoundaryFacts) => {
      const safe = boundary.policyAuthorized
        && boundary.runActivity === 'idle'
        && boundary.controllerInputLease === 'none'
        && boundary.draft === 'empty';
      if (!safe) return { providerCalls, status: request.status };
      const previous = submitted.get(request.status.effectKey);
      if (previous !== undefined) return { providerCalls, status: previous };
      providerCalls += 1;
      const outcome = await provider.submitStatusTurn(request);
      if (!outcome.ok) return { providerCalls, status: request.status };
      submitted.set(request.status.effectKey, outcome.value.status);
      return { providerCalls, status: outcome.value.status };
    },
  };
  await assertSafeBoundaryConsumerContract(
    consumer,
    queuedDriftStatusTurn(),
  );
});

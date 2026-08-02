import test from 'node:test';
import {
  assertSafeBoundaryConsumerContract,
  assertSafeBoundaryRuntimeProviderContract,
  type RuntimeSafeBoundaryProviderHarness,
  type SafeBoundaryConsumerHarness,
  type SafeBoundaryFacts,
  type SubmittedDriftStatus,
} from '../contract/testkit/index.js';
import { queuedDriftStatusTurn } from './fixtures.js';

const provider: RuntimeSafeBoundaryProviderHarness = {
  submitStatusTurn: async ({ status }) => ({
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
  }),
};

test('Runtime provider preserves the queued drift episode across safe submission', async () => {
  await assertSafeBoundaryRuntimeProviderContract(provider, queuedDriftStatusTurn());
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
      const status = await provider.submitStatusTurn(request);
      submitted.set(request.status.effectKey, status);
      return { providerCalls, status };
    },
  };
  await assertSafeBoundaryConsumerContract(
    consumer,
    queuedDriftStatusTurn(),
  );
});

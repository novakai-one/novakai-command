import assert from 'node:assert/strict';
import test from 'node:test';
import {
  b3ok,
  b3err,
  b3fail,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  Notification,
  RecordNotificationTranscriptNonObservationInput,
  RecordNotificationTranscriptObservationInput,
  SupervisionCommands,
  TranscriptDeliveryEvidence,
  TranscriptDeliveryNonObservationEvidence,
} from '../contract/index.js';
import {
  assertNotificationTranscriptObservationProviderContract,
  assertNotificationTranscriptObservationConsumerContract,
  assertNotificationTranscriptNonObservationProviderContract,
  assertNotificationTranscriptNonObservationConsumerContract,
  type NotificationTranscriptNonObservationConsumerHarness,
  type NotificationTranscriptNonObservationProviderHarness,
  type NotificationTranscriptObservationConsumerHarness,
  type NotificationTranscriptObservationProviderHarness,
} from '../contract/testkit/index.js';
import { isDeepStrictEqual } from 'node:util';
import { queuedNotificationEvent } from './fixtures.js';

const OBSERVATION_INPUT: RecordNotificationTranscriptObservationInput = {
  notificationId: `notification_${'a'.repeat(52)}` as never,
  expectedRecordVersion: 3 as never,
  expectedEffectKey: 'b3v4:notification-delivery:q11-positive',
  terminalInputAttemptId:
    'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
  evidence: {
    bindingId: `transcriptBinding_${'b'.repeat(52)}` as never,
    transcriptLineId: `transcriptLine_${'c'.repeat(64)}` as never,
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174000' as never,
    providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    sourcePosition: '0000000042',
    sourceDigest: 'sha256:provider-source-line',
    logicalInputDigest: 'sha256:exact-logical-utf8-input',
  },
};

const NON_OBSERVATION_INPUTS: readonly RecordNotificationTranscriptNonObservationInput[] = [
  {
    notificationId: `notification_${'f'.repeat(52)}` as never,
    expectedRecordVersion: 3 as never,
    expectedEffectKey: 'b3v4:notification-delivery:q11-complete',
    evidence: {
      bindingId: `transcriptBinding_${'g'.repeat(52)}` as never,
      agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ad' as never,
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174002' as never,
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789ad' as never,
      terminalInputAttemptId:
        'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ad' as never,
      reason: 'complete-for-turn',
      sourceDiscoveryState: 'bound',
      completeThroughWatermark: '0000000099',
      evidenceRefs: [
        `transcriptBinding_${'g'.repeat(52)}`,
        'provider-source-result:complete-through-provider-turn',
      ],
    },
  },
  {
    notificationId: `notification_${'h'.repeat(52)}` as never,
    expectedRecordVersion: 3 as never,
    expectedEffectKey: 'b3v4:notification-delivery:q11-missing',
    evidence: {
      bindingId: `transcriptBinding_${'i'.repeat(52)}` as never,
      agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ae' as never,
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174003' as never,
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789ae' as never,
      terminalInputAttemptId:
        'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ae' as never,
      reason: 'final-source-missing',
      sourceDiscoveryState: 'missing',
      evidenceRefs: [
        `transcriptBinding_${'i'.repeat(52)}`,
        'provider-source-result:final-missing',
      ],
    },
  },
  {
    notificationId: `notification_${'j'.repeat(52)}` as never,
    expectedRecordVersion: 3 as never,
    expectedEffectKey: 'b3v4:notification-delivery:q11-corrupt',
    evidence: {
      bindingId: `transcriptBinding_${'k'.repeat(52)}` as never,
      agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789af' as never,
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174004' as never,
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789af' as never,
      terminalInputAttemptId:
        'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789af' as never,
      reason: 'final-source-corrupt',
      sourceDiscoveryState: 'corrupt',
      evidenceRefs: [
        `transcriptBinding_${'k'.repeat(52)}`,
        'provider-source-result:final-corrupt',
      ],
    },
  },
];

const OBSERVED_NOTIFICATION: Notification = {
  ...queuedNotificationEvent('start-turn').payload,
  id: OBSERVATION_INPUT.notificationId,
  recordVersion: 4 as never,
  deliveryEffectKey: OBSERVATION_INPUT.expectedEffectKey,
  deliveryAttempt: {
    state: 'submitted-confirmed',
    effectKey: OBSERVATION_INPUT.expectedEffectKey,
    submittedAt: '2026-08-03T00:00:00.000Z' as never,
    notificationInputReservationId: `notificationInput_${'e'.repeat(52)}` as never,
    terminalInputAttemptId: OBSERVATION_INPUT.terminalInputAttemptId,
    providerTurnId: OBSERVATION_INPUT.evidence.providerTurnId,
  },
  state: 'transcript-observed',
};

const notificationAfterNonObservation = (
  input: RecordNotificationTranscriptNonObservationInput,
  state: Notification['state'] = 'delivery-uncertain',
): Notification => ({
  ...queuedNotificationEvent('start-turn').payload,
  id: input.notificationId,
  recordVersion: 4 as never,
  deliveryEffectKey: input.expectedEffectKey,
  deliveryAttempt: {
    state: 'submitted-confirmed',
    effectKey: input.expectedEffectKey,
    submittedAt: '2026-08-03T00:00:00.000Z' as never,
    notificationInputReservationId: `notificationInput_${'m'.repeat(52)}` as never,
    terminalInputAttemptId: input.evidence.terminalInputAttemptId,
    providerTurnId: input.evidence.providerTurnId,
  },
  state,
});

const q11CommandSurface: Pick<
  SupervisionCommands,
  | 'recordNotificationTranscriptObservation'
  | 'recordNotificationTranscriptNonObservation'
> = {
  recordNotificationTranscriptObservation: async (
    _context: SystemCommandContext<'sys_transcript'>,
    _input: RecordNotificationTranscriptObservationInput,
  ) => b3ok({} as Notification),
  recordNotificationTranscriptNonObservation: async (
    _context: SystemCommandContext<'sys_transcript'>,
    _input: RecordNotificationTranscriptNonObservationInput,
  ) => b3ok({} as Notification),
};

const evidenceSurface = (
  observation: TranscriptDeliveryEvidence,
  nonObservation: TranscriptDeliveryNonObservationEvidence,
) => [observation, nonObservation] as const;

test('Q11 publishes the two Transcript-owned commands and their evidence types', () => {
  assert.deepEqual(Object.keys(q11CommandSurface), [
    'recordNotificationTranscriptObservation',
    'recordNotificationTranscriptNonObservation',
  ]);
  assert.equal(typeof evidenceSurface, 'function');
});

test('Transcript provider preserves the complete positive delivery evidence tuple', async () => {
  const provider: NotificationTranscriptObservationProviderHarness = {
    readNotificationTranscriptObservation: async () => OBSERVATION_INPUT,
  };
  await assertNotificationTranscriptObservationProviderContract(
    provider,
    OBSERVATION_INPUT,
  );
});

test('Supervision promotes only exact positive evidence and replays it idempotently', async () => {
  const consumer: NotificationTranscriptObservationConsumerHarness = {
    recordNotificationTranscriptObservation: async (_context, input) => {
      return isDeepStrictEqual(input, OBSERVATION_INPUT)
        ? b3ok(OBSERVED_NOTIFICATION)
        : b3fail(b3err(
          'WatcherConflict',
          'observation evidence conflicts',
          {},
          false,
        ));
    },
  };
  await assertNotificationTranscriptObservationConsumerContract(
    consumer,
    OBSERVATION_INPUT,
  );
});

test('Transcript provider preserves only durable negative-closure evidence', async () => {
  const provider: NotificationTranscriptNonObservationProviderHarness = {
    readNotificationTranscriptNonObservations: async () => NON_OBSERVATION_INPUTS,
  };
  await assertNotificationTranscriptNonObservationProviderContract(
    provider,
    NON_OBSERVATION_INPUTS,
  );
});

test('Supervision records only durable negative closure and never promotes timeout', async () => {
  const consumer: NotificationTranscriptNonObservationConsumerHarness = {
    recordNotificationTranscriptNonObservation: async (_context, input) => {
      const exact = NON_OBSERVATION_INPUTS.find((candidate) =>
        isDeepStrictEqual(candidate, input));
      if (exact !== undefined) return b3ok(notificationAfterNonObservation(input));
      return b3fail(b3err(
        'WatcherConflict',
        'non-observation evidence conflicts',
        {},
        false,
      ));
    },
  };
  await assertNotificationTranscriptNonObservationConsumerContract(
    consumer,
    NON_OBSERVATION_INPUTS,
  );
});

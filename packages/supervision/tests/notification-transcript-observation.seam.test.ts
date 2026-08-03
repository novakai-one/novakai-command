import assert from 'node:assert/strict';
import test from 'node:test';
import {
  b3ok,
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

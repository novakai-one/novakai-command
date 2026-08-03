import assert from 'node:assert/strict';
import type {
  B3Result,
  SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  Notification,
  RecordNotificationTranscriptNonObservationInput,
  RecordNotificationTranscriptObservationInput,
} from '../index.js';

/** Transcript provider half of Q11's positive observation seam. */
export interface NotificationTranscriptObservationProviderHarness {
  readNotificationTranscriptObservation(): Promise<
    RecordNotificationTranscriptObservationInput
  >;
}

/** Verify Transcript preserves every durable causal and integrity fact. */
export async function assertNotificationTranscriptObservationProviderContract(
  provider: NotificationTranscriptObservationProviderHarness,
  expected: RecordNotificationTranscriptObservationInput,
): Promise<void> {
  const observed = await provider.readNotificationTranscriptObservation();
  assert.deepEqual(observed, expected);
}

/** Transcript provider half of Q11's durable negative-closure seam. */
export interface NotificationTranscriptNonObservationProviderHarness {
  readNotificationTranscriptNonObservations(): Promise<
    readonly RecordNotificationTranscriptNonObservationInput[]
  >;
}

/** Verify the three lawful closure forms preserve all durable evidence. */
export async function assertNotificationTranscriptNonObservationProviderContract(
  provider: NotificationTranscriptNonObservationProviderHarness,
  expected: readonly RecordNotificationTranscriptNonObservationInput[],
): Promise<void> {
  const observed = await provider.readNotificationTranscriptNonObservations();
  assert.deepEqual(observed, expected);
}

/** Supervision owner half of Q11's durable negative-closure seam. */
export interface NotificationTranscriptNonObservationConsumerHarness {
  recordNotificationTranscriptNonObservation(
    context: SystemCommandContext<'sys_transcript'>,
    input: RecordNotificationTranscriptNonObservationInput,
  ): Promise<B3Result<Notification>>;
}

/** Supervision owner half of Q11's positive observation seam. */
export interface NotificationTranscriptObservationConsumerHarness {
  recordNotificationTranscriptObservation(
    context: SystemCommandContext<'sys_transcript'>,
    input: RecordNotificationTranscriptObservationInput,
  ): Promise<B3Result<Notification>>;
}

const TRANSCRIPT_CONTEXT: SystemCommandContext<'sys_transcript'> = {
  principal: {
    id: 'sys_transcript',
    kind: 'system',
    verifiedScopes: [],
  },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
  contractVersion: 1,
};

const changedEvidence = (
  input: RecordNotificationTranscriptObservationInput,
  replacement: Partial<RecordNotificationTranscriptObservationInput['evidence']>,
): RecordNotificationTranscriptObservationInput => ({
  ...input,
  evidence: { ...input.evidence, ...replacement },
});

const changedNonObservationEvidence = (
  input: RecordNotificationTranscriptNonObservationInput,
  replacement: Partial<RecordNotificationTranscriptNonObservationInput['evidence']>,
): RecordNotificationTranscriptNonObservationInput => ({
  ...input,
  evidence: { ...input.evidence, ...replacement },
});

/** Verify exact correlation, conflict on every mismatched fact, and replay safety. */
export async function assertNotificationTranscriptObservationConsumerContract(
  consumer: NotificationTranscriptObservationConsumerHarness,
  expected: RecordNotificationTranscriptObservationInput,
): Promise<void> {
  const cases: readonly [string, RecordNotificationTranscriptObservationInput][] = [
    ['effect-key', { ...expected, expectedEffectKey: `${expected.expectedEffectKey}:wrong` }],
    ['terminal-attempt', {
      ...expected,
      terminalInputAttemptId:
        'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789ac' as never,
    }],
    ['binding', changedEvidence(expected, {
      bindingId: `transcriptBinding_${'d'.repeat(52)}` as never,
    })],
    ['line', changedEvidence(expected, {
      transcriptLineId: `transcriptLine_${'d'.repeat(64)}` as never,
    })],
    ['run', changedEvidence(expected, {
      agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ac' as never,
    })],
    ['session', changedEvidence(expected, {
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174001' as never,
    })],
    ['provider-turn', changedEvidence(expected, {
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789ac' as never,
    })],
    ['source-position', changedEvidence(expected, { sourcePosition: '0000000043' })],
    ['source-digest', changedEvidence(expected, { sourceDigest: 'sha256:wrong-source' })],
    ['logical-input-digest', changedEvidence(expected, {
      logicalInputDigest: 'sha256:wrong-logical-input',
    })],
    ['exact', expected],
    ['exact-replay', expected],
  ];
  const outcomes: [string, string][] = [];
  for (const [name, input] of cases) {
    const result = await consumer.recordNotificationTranscriptObservation(
      TRANSCRIPT_CONTEXT,
      input,
    );
    outcomes.push([name, result.ok ? result.value.state : 'rejected']);
  }
  assert.deepEqual(outcomes, [
    ['effect-key', 'rejected'],
    ['terminal-attempt', 'rejected'],
    ['binding', 'rejected'],
    ['line', 'rejected'],
    ['run', 'rejected'],
    ['session', 'rejected'],
    ['provider-turn', 'rejected'],
    ['source-position', 'rejected'],
    ['source-digest', 'rejected'],
    ['logical-input-digest', 'rejected'],
    ['exact', 'transcript-observed'],
    ['exact-replay', 'transcript-observed'],
  ]);
}

/** Verify only exact durable closure can record uncertainty; timeout never promotes. */
export async function assertNotificationTranscriptNonObservationConsumerContract(
  consumer: NotificationTranscriptNonObservationConsumerHarness,
  expected: readonly RecordNotificationTranscriptNonObservationInput[],
): Promise<void> {
  const complete = expected[0];
  if (complete === undefined) throw new Error('a complete-for-turn fixture is required');
  const { completeThroughWatermark: _omitted, ...evidenceWithoutWatermark } =
    complete.evidence;
  const cases: [string, RecordNotificationTranscriptNonObservationInput][] = [
    ['effect-key', { ...complete, expectedEffectKey: `${complete.expectedEffectKey}:wrong` }],
    ['binding', changedNonObservationEvidence(complete, {
      bindingId: `transcriptBinding_${'l'.repeat(52)}` as never,
    })],
    ['run', changedNonObservationEvidence(complete, {
      agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789b0' as never,
    })],
    ['session', changedNonObservationEvidence(complete, {
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174005' as never,
    })],
    ['provider-turn', changedNonObservationEvidence(complete, {
      providerTurnId: 'providerTurn_018f0f8a-4f7b-7abc-8def-0123456789b0' as never,
    })],
    ['terminal-attempt', changedNonObservationEvidence(complete, {
      terminalInputAttemptId:
        'terminalInput_018f0f8a-4f7b-7abc-8def-0123456789b0' as never,
    })],
    ['reason-state', changedNonObservationEvidence(complete, {
      sourceDiscoveryState: 'missing',
    })],
    ['missing-watermark', { ...complete, evidence: evidenceWithoutWatermark }],
    ['missing-refs', changedNonObservationEvidence(complete, { evidenceRefs: [] })],
    ['timeout', {
      ...complete,
      evidence: {
        ...evidenceWithoutWatermark,
        reason: 'timeout' as never,
        evidenceRefs: [],
      },
    }],
  ];
  for (const [index, input] of expected.entries()) {
    cases.push([`exact-${String(index)}`, input], [`exact-${String(index)}-replay`, input]);
  }
  const outcomes: [string, string][] = [];
  for (const [name, input] of cases) {
    const result = await consumer.recordNotificationTranscriptNonObservation(
      TRANSCRIPT_CONTEXT,
      input,
    );
    outcomes.push([name, result.ok ? result.value.state : 'rejected']);
  }
  assert.deepEqual(outcomes, [
    ['effect-key', 'rejected'],
    ['binding', 'rejected'],
    ['run', 'rejected'],
    ['session', 'rejected'],
    ['provider-turn', 'rejected'],
    ['terminal-attempt', 'rejected'],
    ['reason-state', 'rejected'],
    ['missing-watermark', 'rejected'],
    ['missing-refs', 'rejected'],
    ['timeout', 'rejected'],
    ['exact-0', 'delivery-uncertain'],
    ['exact-0-replay', 'delivery-uncertain'],
    ['exact-1', 'delivery-uncertain'],
    ['exact-1-replay', 'delivery-uncertain'],
    ['exact-2', 'delivery-uncertain'],
    ['exact-2-replay', 'delivery-uncertain'],
  ]);
}

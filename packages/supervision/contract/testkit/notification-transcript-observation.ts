import assert from 'node:assert/strict';
import type {
  B3Result,
  SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  Notification,
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

import assert from 'node:assert/strict';
import { DRIFT_STATUS_PROMPT } from '../index.js';
import type {
  AgentRunId,
  B3Result,
  RecordVersion,
} from '@novakai/foundation/contract';
import type {
  DriftCheckPolicy,
  OutstandingDriftStatus,
  WatchDeadlineId,
} from '../index.js';

/** Queued drift request handed to Runtime; its reply clock has not started. */
export interface SafeBoundaryStatusTurnRequest {
  readonly agentRunId: AgentRunId;
  readonly watchDeadlineId: WatchDeadlineId;
  readonly expectedDeadlineRecordVersion: RecordVersion;
  readonly prompt: DriftCheckPolicy['statusPrompt'];
  readonly status: Extract<OutstandingDriftStatus, { readonly state: 'queued' }>;
}

/** Submission facts Runtime may record after the safe-boundary attempt. */
export type SubmittedDriftStatus = Extract<
  OutstandingDriftStatus,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

/** Observable Runtime result: durable status plus cumulative provider effects. */
export interface SafeBoundarySubmissionObservation {
  readonly status: SubmittedDriftStatus;
  readonly providerEffectsStarted: number;
}

/** Runtime-side provider half of the safe-boundary status-turn seam. */
export interface RuntimeSafeBoundaryProviderHarness {
  submitStatusTurn(
    request: SafeBoundaryStatusTurnRequest,
  ): Promise<B3Result<SafeBoundarySubmissionObservation>>;
}

/** The exact §13.8 gates for a start-turn delivery attempt. */
export interface SafeBoundaryFacts {
  readonly policyAuthorized: boolean;
  readonly runActivity: 'idle' | 'working';
  readonly controllerInputLease: 'none' | 'active';
  readonly draft: 'empty' | 'present';
}

/** Observable consumer result including provider-effect call count. */
export interface SafeBoundaryObservation {
  readonly providerCalls: number;
  readonly status: OutstandingDriftStatus;
}

/** Consumer half that holds a queued effect until Runtime is safe. */
export interface SafeBoundaryConsumerHarness {
  offerStatusTurn(
    request: SafeBoundaryStatusTurnRequest,
    boundary: SafeBoundaryFacts,
  ): Promise<SafeBoundaryObservation>;
}

/** Verify one Runtime attempt preserves episode/effect identity and starts the reply clock. */
export async function assertSafeBoundaryRuntimeProviderContract(
  provider: RuntimeSafeBoundaryProviderHarness,
  request: SafeBoundaryStatusTurnRequest,
): Promise<void> {
  assert.equal(request.status.state, 'queued');
  assert.equal(request.prompt, DRIFT_STATUS_PROMPT);
  assert.equal('submittedAt' in request.status, false);
  assert.equal('replyDueAt' in request.status, false);
  const stale = await provider.submitStatusTurn({
    ...request,
    expectedDeadlineRecordVersion:
      (Number(request.expectedDeadlineRecordVersion) - 1) as RecordVersion,
  });
  assert.equal(stale.ok, false, 'stale expectedDeadlineRecordVersion must be rejected');
  if (!stale.ok) assert.equal(stale.error.code, 'WatcherConflict');
  const outcome = await provider.submitStatusTurn(request);
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
  if (!outcome.ok) return;
  const submitted = outcome.value.status;
  assert.equal(submitted.episodeId, request.status.episodeId);
  assert.equal(submitted.effectKey, request.status.effectKey);
  assert.equal(submitted.notificationId, request.status.notificationId);
  assert.equal(submitted.requestedAt, request.status.requestedAt);
  assert.match(submitted.state, /^submitted-(confirmed|unconfirmed)$/);
  assert.equal(typeof submitted.submittedAt, 'string');
  assert.equal(typeof submitted.replyDueAt, 'string');
  const replyWindowMs = Date.parse(submitted.replyDueAt) - Date.parse(submitted.submittedAt);
  assert.ok(replyWindowMs >= 300_000 && replyWindowMs <= 600_000);
  if (submitted.state === 'submitted-confirmed') {
    assert.equal(typeof submitted.providerTurnId, 'string');
  }
}

/** Verify an uncertain provider submission is recovered, never repeated. */
export async function assertSubmittedUnconfirmedNeverRetries(
  provider: RuntimeSafeBoundaryProviderHarness,
  request: SafeBoundaryStatusTurnRequest,
): Promise<void> {
  const first = await provider.submitStatusTurn(request);
  const replay = await provider.submitStatusTurn(request);
  assert.equal(first.ok, true, first.ok ? '' : first.error.message);
  assert.equal(replay.ok, true, replay.ok ? '' : replay.error.message);
  if (!first.ok || !replay.ok) return;
  assert.equal(first.value.status.state, 'submitted-unconfirmed');
  assert.equal(replay.value.status.state, 'submitted-unconfirmed');
  assert.equal(first.value.providerEffectsStarted, 1);
  assert.equal(replay.value.providerEffectsStarted, 1);
  assert.deepEqual(replay.value.status, first.value.status);
}

const UNSAFE_BOUNDARIES: readonly SafeBoundaryFacts[] = [
  { policyAuthorized: false, runActivity: 'idle', controllerInputLease: 'none', draft: 'empty' },
  { policyAuthorized: true, runActivity: 'working', controllerInputLease: 'none', draft: 'empty' },
  { policyAuthorized: true, runActivity: 'idle', controllerInputLease: 'active', draft: 'empty' },
  { policyAuthorized: true, runActivity: 'idle', controllerInputLease: 'none', draft: 'present' },
];

const SAFE_BOUNDARY: SafeBoundaryFacts = {
  policyAuthorized: true,
  runActivity: 'idle',
  controllerInputLease: 'none',
  draft: 'empty',
};

/** Verify unsafe deferral plus one effect-key-deduplicated safe submission. */
export async function assertSafeBoundaryConsumerContract(
  consumer: SafeBoundaryConsumerHarness,
  request: SafeBoundaryStatusTurnRequest,
): Promise<void> {
  for (const boundary of UNSAFE_BOUNDARIES) {
    const deferred = await consumer.offerStatusTurn(request, boundary);
    assert.equal(deferred.providerCalls, 0);
    assert.equal(deferred.status.state, 'queued');
    assert.equal('replyDueAt' in deferred.status, false);
  }
  const submitted = await consumer.offerStatusTurn(request, SAFE_BOUNDARY);
  assert.equal(submitted.providerCalls, 1);
  assert.notEqual(submitted.status.state, 'queued');
  const replay = await consumer.offerStatusTurn(request, SAFE_BOUNDARY);
  assert.equal(replay.providerCalls, 1);
  assert.deepEqual(replay.status, submitted.status);
}

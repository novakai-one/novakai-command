import {
  readBoundary,
  type AgentRunId,
  type B3Result,
  type ProviderSessionId,
  type ProviderTurnId,
  type ProviderTurnSubmissionId,
  type TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import type {
  ReconcileTranscriptTurnCompletionInput,
  TranscriptTurnCompletionFilter,
} from './api.js';

export function readReconcileTranscriptTurnCompletionInput(
  value: unknown,
): B3Result<ReconcileTranscriptTurnCompletionInput> {
  return readBoundary(value, (field) => ({
    providerTurnId: field.id<ProviderTurnId>('providerTurnId', 'providerTurn'),
    expectedProviderTurnSubmissionId: field.id<ProviderTurnSubmissionId>(
      'expectedProviderTurnSubmissionId', 'providerTurnSubmission', 'base32sha256',
    ),
  }));
}

export function readTranscriptTurnCompletionIdInput(
  value: unknown,
): B3Result<{ readonly transcriptTurnCompletionId: TranscriptTurnCompletionId }> {
  return readBoundary(value, (field) => ({
    transcriptTurnCompletionId: field.id<TranscriptTurnCompletionId>(
      'transcriptTurnCompletionId', 'transcriptTurnCompletion', 'base32sha256',
    ),
  }));
}

export function readTranscriptCompletionStatusInput(
  value: unknown,
): B3Result<{ readonly providerTurnId: ProviderTurnId }> {
  return readBoundary(value, (field) => ({
    providerTurnId: field.id<ProviderTurnId>('providerTurnId', 'providerTurn'),
  }));
}

export function readTranscriptTurnCompletionFilter(
  value: unknown,
): B3Result<TranscriptTurnCompletionFilter> {
  return readBoundary(value, (field) => {
    const agentRunId = field.optionalId<AgentRunId>('agentRunId', 'agentRun');
    const providerSessionId = field.optionalId<ProviderSessionId>(
      'providerSessionId', 'sess', 'uuidv4',
    );
    const providerTurnId = field.optionalId<ProviderTurnId>('providerTurnId', 'providerTurn');
    const cursor = field.optionalText('cursor');
    return {
      ...(agentRunId === undefined ? {} : { agentRunId }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(providerTurnId === undefined ? {} : { providerTurnId }),
      ...(cursor === undefined ? {} : { cursor: cursor as never }),
      limit: field.count('limit', 1, 200),
    };
  });
}

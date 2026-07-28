import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { TranscriptError } from '../contract/errors.js';
import type {
  IngestResult,
  ProviderName,
  SessionRef,
  TranscriptLine,
} from '../contract/schemas.js';
import type { TranscriptContext } from './composition.js';
import {
  ingest,
  linesByProvider,
  linesBySession,
  subagentTree,
} from './ingestion.js';

export interface TranscriptContract {
  ingest(): Promise<Result<IngestResult, TranscriptError>>;
  linesBySession(
    sessionRef: SessionRef,
  ): Promise<Result<TranscriptLine[], TranscriptError>>;
  linesByProvider(
    provider: ProviderName,
    since?: string,
  ): Promise<Result<TranscriptLine[], TranscriptError>>;
  subagentTree(
    turnId: string,
  ): Promise<Result<TranscriptLine[], TranscriptError>>;
}

export function createTranscriptContract(
  context: TranscriptContext,
): TranscriptContract {
  return {
    ingest: () => ingest(context),
    linesBySession: (sessionRef) => linesBySession(context, sessionRef),
    linesByProvider: (provider, since) =>
      linesByProvider(context, provider, since),
    subagentTree: (turnId) => subagentTree(context, turnId),
  };
}

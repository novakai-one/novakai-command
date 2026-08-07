import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { TranscriptError } from '../contract/errors.js';
import type {
  IngestResult,
  ProviderName,
  SessionRef,
  TranscriptIngestionStatus,
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
  status(): Promise<Result<TranscriptIngestionStatus, never>>;
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
  const status: TranscriptIngestionStatus = {
    running: false,
    idle: true,
    lastError: null,
    latched: false,
  };
  let activeIngestions = 0;
  return {
    async ingest() {
      activeIngestions += 1;
      status.running = true;
      status.idle = false;
      try {
        const result = await ingest(context);
        status.lastError = result.ok
          ? null
          : `${result.error.code}: ${result.error.message}`;
        return result;
      } finally {
        activeIngestions -= 1;
        status.running = activeIngestions > 0;
        status.idle = activeIngestions === 0;
      }
    },
    status: async () => ({ ok: true, value: { ...status } }),
    linesBySession: (sessionRef) => linesBySession(context, sessionRef),
    linesByProvider: (provider, since) =>
      linesByProvider(context, provider, since),
    subagentTree: (turnId) => subagentTree(context, turnId),
  };
}

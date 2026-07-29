import path from 'node:path';
import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import type { TranscriptSourceAdapter } from '../contract/source.js';
import {
  createTranscriptContract,
  type TranscriptContract,
} from './contract.js';
import {
  injectTranscriptFailpoint,
  type TranscriptFailpoint,
} from './failpoints.js';

export interface ComposeTranscriptOptions {
  root: string;
  source: TranscriptSourceAdapter;
  legacyRoot?: string;
  lockTimeoutMs?: number;
}

/** @internal Transcript-owned context; never exported from the package root. */
export interface TranscriptContext {
  readonly handle: ScopedStoreHandle;
  readonly source: TranscriptSourceAdapter;
  readonly failpoint: TranscriptFailpoint;
  readonly yieldAfterItems: number;
  readonly yieldToHost: () => Promise<void>;
}

export function composeTranscript(
  options: ComposeTranscriptOptions,
): TranscriptContract {
  const root = path.resolve(options.root);
  return createTranscriptContract({
    handle: composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      legacyRoot: options.legacyRoot,
      capability: 'transcript',
      allowedKinds: [
        'transcriptLine',
        'transcriptJournal',
        'transcriptCheckpoint',
      ],
      principal: 'sys_ingester',
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    source: options.source,
    // Ambient configuration is resolved once at the composition edge. The
    // Transcript core receives injected behavior and never reads process.env.
    failpoint: injectTranscriptFailpoint(process.env.NVK_FAILPOINT),
    // A bounded first scan must release the host macrotask queue. Keeping this
    // scheduler at the composition edge leaves ingestion policy testable
    // without coupling its authoritative behavior to Server.
    yieldAfterItems: 4,
    yieldToHost: () =>
      new Promise<void>((resolve) => setImmediate(resolve)),
  });
}

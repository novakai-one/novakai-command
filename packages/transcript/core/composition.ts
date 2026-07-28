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
  });
}

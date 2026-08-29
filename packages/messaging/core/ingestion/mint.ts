import { createHash } from 'node:crypto';
import type { ProviderName } from '../../contract/types.js';
import {
  idPatterns,
  MessagingError,
  type IngestCheckpointId,
  type ProviderResumeId,
  type ProviderSessionId,
  type TranscriptLineId,
} from '../../contract/types.js';

/**
 * The one module where ingestion's branded values are born, each checked
 * against the contract pattern before the brand is applied. A failed check
 * means minting drifted from the contract — a defect, not bad input — so it
 * halts as a non-retryable dependency failure instead of writing an
 * off-pattern id.
 */

const patterns = {
  session: new RegExp(idPatterns.ProviderSessionId, 'u'),
  checkpoint: new RegExp(idPatterns.IngestCheckpointId, 'u'),
  line: new RegExp(idPatterns.TranscriptLineId, 'u'),
} as const;

/** SHA-256 hex of one value; the single hashing primitive for ids and content hashes. */
export const digest = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/** Applies the brand after the pattern check; the only place casts live. */
function minted<T extends string>(candidate: string, pattern: RegExp, kind: string): T {
  if (!pattern.test(candidate)) {
    throw new MessagingError('DependencyUnavailable', {
      message: `minted ${kind} no longer matches the contract pattern`,
      fields: { dependency: 'ingestion-mint', kind, candidate },
    });
  }
  return candidate as T;
}

/**
 * A v5-style UUID from the first 32 hash nibbles, so a session id is
 * deterministic for one (provider, identity) pair: a restarted pass
 * re-discovers the same session instead of registering a twin.
 */
function uuidFrom(value: string): string {
  const characters = digest(value).slice(0, 32).split('');
  characters[12] = '5';
  characters[16] = ['8', '9', 'a', 'b'][Number.parseInt(characters[16] ?? '0', 16) % 4] ?? '8';
  const joined = characters.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

/** Deterministic session id for one provider identity (resume id, else the source id). */
export function mintProviderSessionId(provider: ProviderName, identity: string): ProviderSessionId {
  return minted(`sess_${uuidFrom(`${provider}:${identity}`)}`, patterns.session, 'ProviderSessionId');
}

/** Deterministic checkpoint id for one provider source. */
export function mintIngestCheckpointId(sourceId: string): IngestCheckpointId {
  return minted(`ingestCheckpoint_${digest(sourceId)}`, patterns.checkpoint, 'IngestCheckpointId');
}

/**
 * Deterministic line id: a provider's own line id when it has one, else the
 * hash of the raw line, so uuid dedupe survives a recalibrated re-read.
 */
export function mintTranscriptLineId(
  sessionId: ProviderSessionId,
  providerLineId: string | undefined,
  rawLine: string,
): TranscriptLineId {
  const uniqueness = providerLineId ?? digest(rawLine);
  return minted(`transcriptLine_${digest(`${sessionId}:${uniqueness}`)}`, patterns.line, 'TranscriptLineId');
}

/**
 * Brands a provider-issued resume id. The contract has no pattern for this
 * brand yet — provider formats vary — so the only honest check is presence:
 * an empty resume id is a defect, not a value.
 */
export function mintProviderResumeId(value: string): ProviderResumeId {
  if (value.trim().length === 0) {
    throw new MessagingError('DependencyUnavailable', {
      message: 'provider resume id is empty',
      fields: { dependency: 'ingestion-mint', kind: 'ProviderResumeId' },
    });
  }
  return value as ProviderResumeId;
}

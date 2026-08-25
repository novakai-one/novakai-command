import type {
  ProviderName,
  TranscriptRole,
  TranscriptSourceId,
} from "../types.js";
import type { IngestCheckpoint, ProviderFileSignature } from "../records/ingest-checkpoint.js";
import type { AgentIdentityMarker } from "../records/agent-identity.js";

/** Metadata-only view of one discovered provider session file. */
export interface ProviderSourceStat {
  readonly sourceId: TranscriptSourceId;
  readonly provider: ProviderName;
  readonly size: number;
  readonly device: string;
  readonly inode: string;
  /** Adapter-only hint; core never receives a filesystem path. */
  readonly resumeIdHint?: string;
}

/** Verified bytes appended since the source's last committed checkpoint. */
export interface ProviderSourceGrowth {
  readonly sourceId: TranscriptSourceId;
  readonly provider: ProviderName;
  readonly sourceEpoch: number;
  readonly fromOffset: number;
  /** Verified committed bytes immediately before `fromOffset`, at most 64. */
  readonly priorTail: Uint8Array;
  readonly bytes: Uint8Array;
  readonly signatureAtRead: Omit<ProviderFileSignature, "tailHash">;
}

/** The only port allowed to represent provider-owned transcript files. */
export interface ProviderTranscriptSource {
  scan(): Promise<readonly ProviderSourceStat[]>;
  readGrowth(
    source: ProviderSourceStat,
    checkpoint: IngestCheckpoint | null,
  ): Promise<ProviderSourceGrowth>;
}

/** One complete provider JSONL row and its byte boundaries. */
export interface ProviderLineExtent {
  readonly raw: string;
  readonly offset: number;
  readonly nextOffset: number;
}

/** Pure provider-neutral interpretation of one source row. */
export interface NormalizedProviderLine {
  readonly role: TranscriptRole;
  readonly text: string;
  /** Provider-native event identity, when the format exposes one. */
  readonly providerLineId?: string;
  readonly resumeId?: string;
  readonly turnId?: string;
  readonly parentTurnId?: string;
  readonly toolCall?: Readonly<Record<string, unknown>>;
  readonly tokenUsage?: Readonly<Record<string, number>>;
  readonly providerOccurredAt?: string;
  readonly correlationHint?: string;
  readonly agentIdentity?: AgentIdentityMarker;
}

/** Provider format variation; normalization is pure and performs no I/O. */
export interface ProviderNormalizer {
  readonly provider: ProviderName;
  normalize(
    extent: ProviderLineExtent,
    turnIndex: number,
  ): NormalizedProviderLine;
}

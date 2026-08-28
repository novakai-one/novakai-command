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
  /** Source modification time used to prioritize post-boot and pending-send evidence. */
  readonly modifiedAt: string;
  /** Composition-approved external adoption scope; no path crosses the port. */
  readonly adoptionEligible: boolean;
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

/**
 * Keeps filesystem paths outside Messaging core. A source signal permits a
 * targeted metadata refresh; discovery invalidates targeted work and requires
 * a complete scan.
 */
export type ProviderSourceChange =
  | { readonly kind: 'source'; readonly sourceId: TranscriptSourceId }
  | { readonly kind: 'discovery' };

/**
 * Represents one active provider-source notification subscription. Closing is
 * idempotent and permanently silences that subscription.
 */
export interface ProviderSourceSubscription {
  close(): void;
}

/**
 * Owns all provider-transcript filesystem access. Sources implementing both
 * optional change capabilities use targeted event-driven ingestion; other
 * sources retain interval polling. Targeted reads are valid only after the same
 * adapter instance has discovered the source.
 */
export interface ProviderTranscriptSource {
  scan(): Promise<readonly ProviderSourceStat[]>;
  statKnown?(
    sourceIds?: readonly TranscriptSourceId[],
  ): Promise<readonly ProviderSourceStat[]>;
  watchChanges?(
    notify: (change: ProviderSourceChange) => void,
  ): Promise<ProviderSourceSubscription>;
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
  /** Explicit semantic audience; hosts never infer displayability from `role`. */
  readonly audience: "conversation" | "internal";
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

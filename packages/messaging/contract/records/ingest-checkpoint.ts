import type {
  IngestCheckpointId,
  ProviderName,
  Timestamp,
  TranscriptSourceId,
} from "../types.js";

/** Provider-file identity and verification tail at the committed offset. */
export interface ProviderFileSignature {
  readonly device: string;
  readonly inode: string;
  /** SHA-256 of the last at-most-64 committed source bytes. */
  readonly tailHash: string;
}

/** Durable progress for one provider source; offset is a fast path only. */
export interface IngestCheckpoint {
  readonly id: IngestCheckpointId;
  readonly kind: "ingest-checkpoint";
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly provider: ProviderName;
  readonly sourceId: TranscriptSourceId;
  readonly sourceEpoch: number;
  readonly offset: number;
  readonly nextTurnIndex: number;
  readonly fileSignature: ProviderFileSignature;
}

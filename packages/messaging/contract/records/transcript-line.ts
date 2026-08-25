import type {
  ProviderName,
  ProviderSessionId,
  Timestamp,
  TranscriptLineId,
  TranscriptRole,
  TranscriptSourceId,
} from "../types.js";

/** Exact provider-source extent retained for custody and recalibration. */
export interface TranscriptSourcePosition {
  readonly sourceId: TranscriptSourceId;
  readonly sourceEpoch: number;
  readonly offset: number;
  readonly nextOffset: number;
}

/** Immutable normalized provider event. `raw` is the custody evidence. */
export interface TranscriptLine {
  readonly id: TranscriptLineId;
  readonly kind: "transcript-line";
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly sessionId: ProviderSessionId;
  readonly provider: ProviderName;
  readonly sourcePosition: TranscriptSourcePosition;
  readonly turnIndex: number;
  readonly role: TranscriptRole;
  readonly text: string;
  readonly raw: string;
  readonly turnId?: string;
  readonly parentTurnId?: string;
  readonly toolCall?: Readonly<Record<string, unknown>>;
  readonly tokenUsage?: Readonly<Record<string, number>>;
  readonly providerOccurredAt?: string;
  readonly correlationHint?: string;
  readonly agentIdentity?: string;
}

import type {
  ProviderName,
  ProviderResumeId,
  ProviderSessionId,
  ProviderSessionStatus,
  Timestamp,
  TranscriptSourceId,
} from "../types.js";

/** Messaging-owned registration of one provider conversation. */
export interface ProviderSession {
  readonly id: ProviderSessionId;
  readonly kind: "provider-session";
  readonly schemaVersion: 1;
  readonly createdAt: Timestamp;
  readonly provider: ProviderName;
  readonly sourceIds: readonly TranscriptSourceId[];
  readonly status: ProviderSessionStatus;
  readonly agentId?: string;
  readonly resumeId?: ProviderResumeId;
}

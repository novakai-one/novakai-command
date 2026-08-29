import type { ProviderName } from "../../contract/types.js";
import type {
  ProviderNormalizer,
  ProviderTranscriptSource,
} from "../../contract/ports/provider-transcript-source.js";
import type { TranscriptStore } from "../../contract/ports/transcript-store.js";
import type { MessagingTraceSink } from "../../contract/trace.js";
import type {
  AdoptionAssignment,
  AgentDirectory,
} from "../../contract/ports/agent-directory.js";
import type { ConversationDirectory } from "../../contract/ports/conversation-directory.js";
import type { ProviderSend } from "../../contract/ports/provider-send.js";
import type { DurableTranscriptEventBus } from "../event-bus.js";

/**
 * Configures provider ingestion and delivery scheduling. Maintenance defaults
 * to one second and remains the polling cadence for sources without complete
 * event support; safety discovery defaults to 60 seconds and source changes
 * are coalesced for 25 milliseconds by default.
 */
export interface MessagingRuntimeOptions {
  readonly store: TranscriptStore;
  readonly source: ProviderTranscriptSource;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly now?: () => string;
  readonly intervalMs?: number;
  readonly safetySweepMs?: number;
  readonly changeDebounceMs?: number;
  readonly eventBus?: DurableTranscriptEventBus;
  readonly trace?: MessagingTraceSink;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
  readonly conversations?: ConversationDirectory;
  readonly conversationPrincipalId?: string;
  readonly adoption?: {
    readonly assignment: AdoptionAssignment;
    readonly conversations?: ConversationDirectory;
    readonly limitPerTick: number;
  };
  readonly storeId?: string;
}

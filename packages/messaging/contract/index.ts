/** The sole legal consumer doorway for the Messaging capability. */
export * from "./schemas.js";
export * from "./brands.js";
export * from "./api.js";
export * from "./outcome.js";
export * from "./runtime.js";
export * from "./agent-identity.js";
export * from './agent-delivery-marker.js';
export * from './communications.js';
export * from './conversations.js';
export * from "./commands.js";
export * from "./compose.js";
export * from "./records/index.js";
export type {
  NormalizedProviderLine,
  ProviderLineExtent,
  ProviderNormalizer,
  ProviderSourceGrowth,
  ProviderSourceStat,
  ProviderTranscriptSource,
} from "./ports/provider-transcript-source.js";
export type {
  TranscriptBatchInput,
  TranscriptBatchResult,
  TranscriptEvent,
  TranscriptLineQuery,
  TranscriptStore,
  AcceptSendInput,
  AcceptSendResult,
  AcceptPendingDeliveryInput,
  PendingDeliveryTransitionInput,
  PendingDeliveryTransitionResult,
  SendTransitionInput,
  SendTransitionResult,
} from "./ports/transcript-store.js";
export type {
  AgentDirectory,
  AgentDirectoryEntry,
  AdoptionAssignment,
  AgentEnsureOutcome,
  AgentSessionAttachment,
  EnsureAgentForSessionInput,
} from "./ports/agent-directory.js";
export type {
  ConversationDirectory,
  EnsureAdoptedConversationInput,
  EnsureAgentPairConversationInput,
} from "./ports/conversation-directory.js";
export { createAgentDirectory } from "./compose/agent-directory.js";
export type {
  ProviderDispatchResult,
  ProviderSend,
  ProviderSendInput,
} from "./ports/provider-send.js";
export { createAgentsProviderSend } from "../adapters/provider-send/agents-provider-send.js";

export { WS_PROTOCOL_VERSION } from "./standalone/frames.js";
export type {
  ClientFrame,
  DeliveryFrame,
  ErrorFrame,
  ServerFrame,
} from "./standalone/frames.js";

export { createSystemClock } from "../adapters/clock-system.js";
export { createSeededClock } from "../adapters/clock-seeded.js";
export type { SeededClock, SeededClockOptions } from "../adapters/clock-seeded.js";
export { createMemoryStore } from "../adapters/store-memory.js";
export { createMemoryTranscriptStore } from "../adapters/stores/memory.js";
export { openFoundationTranscriptStore } from "../adapters/stores/jsonl.js";
export type { FoundationTranscriptStoreOptions } from "../adapters/stores/jsonl.js";
export { createProviderTranscriptSource } from "../adapters/provider-transcripts/source.js";
export type { ProviderTranscriptRoots } from "../adapters/provider-transcripts/source.js";
export { providerNormalizer } from "../adapters/provider-transcripts/normalizers/index.js";
export {
  agentIdentityHookCommand,
  markerFromEnvironment,
  runAgentIdentityHook,
} from "../adapters/provider-hooks/agent-identity-hook.js";
export { ensureClaudeIdentityHook } from "../adapters/provider-hooks/registrations/claude.js";
export { ensureCodexIdentityHook } from "../adapters/provider-hooks/registrations/codex.js";
export { ensureKimiIdentityHook } from "../adapters/provider-hooks/registrations/kimi.js";
export { openJsonlStore } from "../adapters/store-jsonl.js";
export { createConfigAuthority, DEFAULT_ROLE_GRANTS } from "../adapters/authority-config.js";
export type {
  AuthorityConfig,
  ConfigAuthority,
  PrincipalConfig,
} from "../adapters/authority-config.js";
export { createConfigMembership } from "../adapters/membership-config.js";
export type {
  ConfigMembership,
  MembershipConfig,
  MembershipRoomConfig,
} from "../adapters/membership-config.js";
export { createMemoryPresenceTransport } from "../adapters/presence-transport-memory.js";
export type {
  MemoryPresenceTransport,
  MemoryPresenceTransportOptions,
} from "../adapters/presence-transport-memory.js";
export { createPtyPresenceTransport } from "../adapters/presence-transport-pty.js";
export type {
  PtyChildLike,
  PtyChildStdin,
  PtyPresenceTransport,
  PtyPresenceTransportOptions,
  PtySpawn,
} from "../adapters/presence-transport-pty.js";
export { DEFAULT_RETRY_POLICY } from "./ports/presence-transport.js";
export { membershipUnavailable, unknownRoom } from "./ports/membership.js";

// Existing B3 contract remains available through this sole doorway until TF-06
// folds its records into the transcript-first model.
export * from "../b3/contract/index.js";

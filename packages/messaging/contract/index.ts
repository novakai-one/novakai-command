/**
 * Host doorway for the Messaging capability.
 *
 * This module carries ONLY the names an outside consumer (packages/server)
 * actually imports. Everything else is imported from the module that owns
 * it: contract/runtime.ts, contract/ports/, contract/records/,
 * contract/compose/, core/ and adapters/.
 */

/** The runtime surface a host drives: lifecycle, ingestion, committed queries, subscriptions. */
export type { MessagingRuntimeApi } from "./runtime.js";

/** Typed result returned by every runtime call; implementation exceptions never cross this door. */
export type { Outcome } from "./outcome.js";

/** One Communications-screen row projected from transcript-first authority. */
export type { AgentCommunicationView } from "./communications.js";

/** Instruction whose marker becomes provider-native transcript evidence on delivery. */
export type { AgentDeliveryInstruction } from "./agent-delivery-marker.js";

/** Immutable normalized provider event; `raw` is the custody evidence. */
export type { TranscriptLine } from "./records/transcript-line.js";

/** Host seam Messaging crosses to ensure a Conversation exists for an adopted Agent or an Agent pair. */
export type { ConversationDirectory } from "./ports/conversation-directory.js";

/** Scope, operating assignment and rate limit for adopting externally-started provider sessions. */
export type { ExternalAdoptionOptions } from "./compose/ingestion.js";

/** Production composition: wires stores, provider sources and identity hooks into one runtime. */
export { createDefaultMessagingRuntime } from "./compose/ingestion.js";

/** Binds Messaging to the public Agents contract for directory lookups and session adoption. */
export { createAgentDirectory } from "./compose/agent-directory.js";

/** Adapts the public Agents contract to one completed provider CLI turn. */
export { createAgentsProviderSend } from "../adapters/provider-send/agents-provider-send.js";

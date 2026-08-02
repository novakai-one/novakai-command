/**
 * The B3c Messaging public door.
 *
 * §3.1's public-import law: another package reaches this capability through
 * `contract/` and nothing else. Everything below — `core/`, `adapters/`,
 * `seams/` — is private, and the architecture test in packages/server fails
 * the build if a consumer reaches past this file.
 */

export * from './api.js';
export * from './records.js';
export {
  composeAgentMessaging, createMemoryConversationViews,
  type AgentDirectoryPort, type AgentMessagingOptions, type CapabilityEventEmitter,
  type ConversationViewPort,
} from '../core/compose.js';
export {
  openFoundationMessagingStore,
  type FoundationMessagingStoreOptions, type MessagingStoreOpPayload,
} from '../adapters/store-foundation.js';
export { agentIdOf, agentPersonId, isAgentPerson } from '../core/identity.js';
export {
  checkMessagingStoreRoute, listMigratedOperations, normaliseLegacyOp,
  readMessagingCutoverReceipt, runMessagingCutover,
  type MessagingCutoverInput, type MessagingCutoverOutcome, type MessagingCutoverReceipt,
} from '../adapters/cutover.js';
export { readLegacyStoreOp } from '../adapters/cutover-validate.js';
export type { MessagingStore } from '../../seams/store.js';
export { createSystemClock } from '../../adapters/clock-system.js';
export type { ClockIds } from '../../seams/clock.js';

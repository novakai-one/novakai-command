/**
 * messaging/public — the ONLY importable surface of the capability (Plan §17).
 * Seams, adapters, core, and composition are private by construction; what a
 * host needs to compose the embedded mode (the composition root, adapter
 * factories, seam types, adapter config types) is re-exported HERE and
 * nowhere else.
 */

export * from "./contract/index.js";
export * from "./capability.js";

// Composition root (embedded mode, Plan §17).
export { createEmbeddedMessaging, EMBEDDED_PROTOCOL_VERSION } from "../composition/embedded.js";
export type { EmbeddedMessaging, EmbeddedMessagingOptions } from "../composition/embedded.js";

// Composition root (standalone mode, DEC-17): WS protocol + store-jsonl.
export {
  createStandaloneMessaging,
  STANDALONE_PROTOCOL_VERSION,
  DEFAULT_STANDALONE_PORT,
  DEFAULT_STANDALONE_HOST,
} from "../composition/standalone.js";
export type {
  StandaloneMessaging,
  StandaloneMessagingOptions,
} from "../composition/standalone.js";

// DEC-17 wire types (adapter surface — protocol envelopes, not contract).
export { WS_PROTOCOL_VERSION } from "../protocol/frames.js";
export type {
  ClientFrame,
  ServerFrame,
  DeliveryFrame,
  ErrorFrame,
} from "../protocol/frames.js";

// Adapter factories a host composes with (clock, store, authority, transport).
// store-memory is test/harness only (A4); store-jsonl is the production default.
export { createSystemClock } from "../adapters/clock-system.js";
export { createSeededClock } from "../adapters/clock-seeded.js";
export type { SeededClock, SeededClockOptions } from "../adapters/clock-seeded.js";
export { createMemoryStore } from "../adapters/store-memory.js";
export { openJsonlStore } from "../adapters/store-jsonl.js";
export { createConfigAuthority, DEFAULT_ROLE_GRANTS } from "../adapters/authority-config.js";
export type {
  AuthorityConfig,
  ConfigAuthority,
  PrincipalConfig,
} from "../adapters/authority-config.js";
export { createMemoryPresenceTransport } from "../adapters/presence-transport-memory.js";
export type {
  MemoryPresenceTransport,
  MemoryPresenceTransportOptions,
} from "../adapters/presence-transport-memory.js";

// Composition-tuning types (the retry budget is adapter configuration, R5).
export { DEFAULT_RETRY_POLICY } from "../seams/presenceTransport.js";

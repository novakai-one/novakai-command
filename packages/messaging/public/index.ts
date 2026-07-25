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
// Audit F10 (accept-and-document): this export hard-imports node:child_process
// (the PTY adapter's spawn), so importing this door pulls a Node builtin. That
// is honest for v1: every v1 host is Node (the embedded composition root and
// the DEC-17 standalone server both run on Node >= 20, per engines). A host
// that cannot tolerate node:child_process must not import this door — it
// composes composition/embedded.js directly (whose adapter imports are the
// clock, the config authority/membership, and the memory store/transport —
// no child_process) with its own transport adapters; if such a host ever
// needs THIS door, the PTY export becomes a lazy subpath. Recorded, not
// silently inherited.
export { createPtyPresenceTransport } from "../adapters/presence-transport-pty.js";
export type {
  PtyPresenceTransport,
  PtyPresenceTransportOptions,
  PtyChildLike,
  PtyChildStdin,
  PtySpawn,
} from "../adapters/presence-transport-pty.js";

// Composition-tuning types (the retry budget is adapter configuration, R5).
export { DEFAULT_RETRY_POLICY } from "../seams/presenceTransport.js";
// Membership-seam §3.3 failure constructors — the documented adapter-extension
// vocabulary (hosts writing a membership adapter reuse these, like authority's).
export { membershipUnavailable, unknownRoom } from "../seams/membership.js";

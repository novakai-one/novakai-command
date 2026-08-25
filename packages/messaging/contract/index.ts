/** The sole legal consumer doorway for the Messaging capability. */
export * from "./schemas.js";
export * from "./brands.js";
export * from "./api.js";
export * from "./compose.js";

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

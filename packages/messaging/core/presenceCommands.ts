/**
 * Presence commands — OpenPresence / ClosePresence (R9).
 *
 * R9: explicit OpenPresence is the ONLY registration mechanism; duplicate
 * opens mint a new Presence each time. The composition rule (Seams §4):
 * naming a transport with no registered adapter fails ValidationFailed — it
 * can never hang, silently no-op, or reach an absent adapter.
 *
 * ClosePresence is idempotent (unknown/already-closed succeeds) and
 * owner-scoped: only the owning Person (or policy.admin) may close;
 * transport-initiated closes never cross this command — they arrive via the
 * liveness callbacks into the same single close path.
 */

import { MessagingError } from "../contract/schemas.js";
import type { TransportKind } from "../contract/schemas.js";
import type {
  ClosePresenceInput,
  OpenPresenceInput,
  PresenceClosed,
  PresenceOpened,
} from "../contract/schemas.js";
import type { Principal } from "../contract/ports/authority.js";
import type { PresenceTransport } from "../contract/ports/presence-transport.js";
import type { PresenceRegistry } from "./presenceRegistry.js";

export interface PresenceCommandsDeps {
  registry: PresenceRegistry;
  /** The composition root's registered transports (Seams §4 composition rule). */
  transports: ReadonlyMap<TransportKind, PresenceTransport>;
}

export function createPresenceCommands(deps: PresenceCommandsDeps) {
  const { registry, transports } = deps;

  async function openPresence(
    principal: Principal,
    input: OpenPresenceInput,
  ): Promise<PresenceOpened> {
    if (!transports.has(input.transport)) {
      throw new MessagingError("ValidationFailed", {
        message: `no adapter registered for transport ${JSON.stringify(input.transport)} in this composition`,
        retryable: false,
        fields: {
          issues: [{ path: "transport", message: `unregistered transport ${JSON.stringify(input.transport)}` }],
        },
      });
    }
    const presence = await registry.open(principal.personId, input.transport, input.clientLabel);
    return { presenceId: presence.id };
  }

  async function closePresence(
    principal: Principal,
    input: ClosePresenceInput,
  ): Promise<PresenceClosed> {
    const presence = registry.lookup(input.presenceId);
    if (!presence) return {}; // idempotent (R9): unknown/already-closed succeeds
    if (presence.personId !== principal.personId && !principal.grants.includes("policy.admin")) {
      throw new MessagingError("NotAuthorized", {
        message: "only the owning Person (or policy.admin) may close a Presence (R9)",
        retryable: false,
        fields: { requiredGrant: "policy.admin" },
      });
    }
    await registry.closePath(input.presenceId);
    return {};
  }

  return { openPresence, closePresence };
}

export type PresenceCommands = ReturnType<typeof createPresenceCommands>;

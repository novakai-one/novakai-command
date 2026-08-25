/**
 * Presence registry (R9, DEC-02) — the core's runtime presence state.
 *
 * Presence is EPHEMERAL (DEC-02): it lives here in the core, never in the
 * store. Registration happens ONLY via explicit OpenPresence — authentication
 * alone never registers (R9). Duplicate opens are allowed and mint a new
 * Presence each time (0..n per Person).
 *
 * THE SINGLE CLOSE PATH: every close — graceful ClosePresence, transport
 * onDisconnect, transport onLivenessTimeout — funnels through `closePath`.
 * Close is idempotent (closing an unknown/already-closed Presence succeeds).
 * The core runs no liveness heuristics; stale detection is the transport
 * adapter's job and arrives via the liveness callbacks (Seams §4.1).
 *
 * Listeners: `onOpened` re-triggers attempt decisions (R5 no-presence rule:
 * each PresenceChanged(opened) re-triggers an attempt decision for that
 * recipient). `onChanged` emits the PresenceChanged OBSERVATION (R11 — no
 * sequence, never journaled) for the subscription layer (S1-c/S3); when a
 * Presence closes, every subscription bound to it must end (Seams §4.1) —
 * there are no subscriptions in S1-b, so the hook is the listener set only.
 */

import { schemaVersion } from "../contract/schemas.js";
import type {
  PersonId,
  Presence,
  PresenceChangedChange,
  PresenceChangedEvent,
  PresenceId,
  TransportKind,
} from "../contract/schemas.js";
import type { ClockIds } from "../contract/ports/clock.js";
import type { TransportLivenessCallbacks } from "../contract/ports/presence-transport.js";

export type PresenceOpenedListener = (presence: Presence) => Promise<void>;
export type PresenceChangedListener = (event: PresenceChangedEvent) => Promise<void>;

export interface PresenceRegistry {
  /** OpenPresence path. Awaits opened-listeners (attempt re-trigger) before returning. */
  open(personId: PersonId, transport: TransportKind, clientLabel?: string): Promise<Presence>;
  lookup(presenceId: PresenceId): Presence | undefined;
  presencesFor(personId: PersonId): Presence[];
  /** Every live Presence (R1: current presence state is sent as fresh observations on (re)subscribe). */
  all(): Presence[];
  /** THE single close path (R9). Idempotent: unknown/already-closed is a no-op. */
  closePath(presenceId: PresenceId): Promise<void>;
  /** The callbacks transport adapters raise into the core (Seams §4.1). */
  readonly liveness: TransportLivenessCallbacks;
  onOpened(listener: PresenceOpenedListener): void;
  onChanged(listener: PresenceChangedListener): void;
}

export function createPresenceRegistry(clock: ClockIds): PresenceRegistry {
  const presences = new Map<string, Presence>();
  const openedListeners: PresenceOpenedListener[] = [];
  const changedListeners: PresenceChangedListener[] = [];

  async function emit(presence: Presence, change: PresenceChangedChange): Promise<void> {
    const event: PresenceChangedEvent = { presence, change };
    for (const listener of changedListeners) {
      await listener(event);
    }
  }

  async function closePath(presenceId: PresenceId): Promise<void> {
    const presence = presences.get(presenceId);
    if (!presence) return; // idempotent (R9): already closed is the desired end state
    presences.delete(presenceId);
    // Seams §4.1: a closing Presence ends its subscriptions (best-effort
    // ended{closed}). No subscriptions exist in S1-b; the subscription layer
    // (S1-c/S3) hooks this via onChanged.
    await emit(presence, "closed");
  }

  return {
    async open(personId, transport, clientLabel): Promise<Presence> {
      const presence: Presence = {
        id: clock.newId("presence"),
        kind: "presence",
        schemaVersion,
        createdAt: clock.now(),
        personId,
        transport,
        ...(clientLabel !== undefined ? { clientLabel } : {}),
      };
      presences.set(presence.id, presence);
      await emit(presence, "opened");
      for (const listener of openedListeners) {
        await listener(presence);
      }
      return presence;
    },

    lookup(presenceId) {
      return presences.get(presenceId);
    },

    presencesFor(personId) {
      return [...presences.values()].filter((presence) => presence.personId === personId);
    },

    all() {
      return [...presences.values()];
    },

    closePath,

    liveness: {
      onDisconnect(presenceId: PresenceId): void {
        void closePath(presenceId);
      },
      onLivenessTimeout(presenceId: PresenceId): void {
        void closePath(presenceId);
      },
    },

    onOpened(listener) {
      openedListeners.push(listener);
    },
    onChanged(listener) {
      changedListeners.push(listener);
    },
  };
}

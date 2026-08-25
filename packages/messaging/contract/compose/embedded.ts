/**
 * composition/embedded.ts — THE composition root for in-process hosts
 * (Plan §17 embedded mode). A thin adapter-choosing wrapper over
 * composition/coreStack.ts — the ONE wiring shared with standalone mode (the
 * "no per-mode business logic" law; the stack was extracted in S1-c).
 *
 * Mode differences (and the ONLY mode differences):
 *  - Defaults: clock-system, store-memory. store-memory is test/harness only
 *    (A4) — a production embedded host passes openJsonlStore explicitly.
 *  - transports default to one presence-transport-memory registered as "ws".
 *    OpenPresence naming an unregistered transport fails ValidationFailed
 *    (Seams §4 composition rule).
 *  - The event bus is NOT interval-driven here: embedded hosts/tests call
 *    pumpEvents() explicitly (deterministic under clock-seeded). Event
 *    content is journal-sourced either way (emit-only-after-durable).
 *  - Revalidation (§2.1): there is no protocol adapter in embedded mode, so
 *    the trigger lives in the session wrapper — lazy at expiresAt, explicit
 *    via session.revalidate(). An ended session terminates its subscriptions
 *    (ended{auth-lost}) via the stack's onEnded wiring.
 *  - DEC-21: runRecoverySweep() is exposed as a composition-owned handle;
 *    start() runs the sweep BEFORE anything else (F10: accept-after-sweep
 *    parity with the standalone root, which sweeps before accepting
 *    connections). With sweepIntervalMs set, the stack ALSO sweeps
 *    periodically on an unref'd timer (Store-Seam §7, F11) — standalone sets
 *    a 60 s default; embedded defaults to manual-only so test harnesses stay
 *    deterministic.
 *
 * Embedded consumers Subscribe through session.subscribe(input, sink): the
 * sink is the host's push lane — the same SubscriptionManager serves both
 * modes (S1-c).
 */

import type { CapabilityView } from "../schemas.js";
import type { EmbeddedAuthOutcome } from "../api.js";
import type { ClockIds } from "../ports/clock.js";
import type { MessagingStore } from "../ports/store.js";
import type { Authority, ProvisioningDirectory } from "../ports/authority.js";
import type { MembershipSource } from "../ports/membership.js";
import type { PresenceTransport } from "../ports/presence-transport.js";
import type { AuthorityConfig, ConfigAuthority } from "../../adapters/authority-config.js";
import type { PresenceRegistry } from "../../core/presenceRegistry.js";
import type { EventBus } from "../../core/eventBus.js";
import type { RecoverySweepReport } from "../../core/recoverySweep.js";
import { createCoreStack } from "./stack.js";
import type { CoreStack, CoreStackOptions } from "./stack.js";

/** DEC-17 protocol version advertised by GetCapabilities. */
export const EMBEDDED_PROTOCOL_VERSION = "1.0.0";

export type EmbeddedMessagingOptions = CoreStackOptions;

export interface EmbeddedMessaging {
  /** Pre-authentication discovery (R3): versions + limits only. */
  getCapabilities(): CapabilityView;
  authenticate(credential: unknown): Promise<EmbeddedAuthOutcome>;
  /**
   * Run the DEC-21 recovery sweep (F10: accept-after-sweep parity with the
   * standalone root), provision configured room Threads (Store-Seam §11.4)
   * and start the bus position. Idempotent (the sweep re-drives harmlessly;
   * createRoomThread is a get-or-create). Hosts with a membership config
   * MUST call this before serving; without rooms it is a no-op beyond the
   * sweep and the bus tail position (embedded events still flow via
   * pumpEvents either way).
   */
  start(): Promise<void>;
  /** One journal tail cycle NOW — embedded determinism for the event bus. */
  pumpEvents(): Promise<void>;
  /** DEC-21 recovery sweep, on demand (idempotent; safe with zero pending). */
  runRecoverySweep(): Promise<RecoverySweepReport>;
  close(): Promise<void>;
  /** Composition-owned handles for hosts/harnesses (not contract surface). */
  readonly clock: ClockIds;
  readonly store: MessagingStore;
  readonly authority: Authority & ProvisioningDirectory;
  readonly membership: MembershipSource;
  readonly transports: readonly PresenceTransport[];
  readonly registry: PresenceRegistry;
  readonly bus: EventBus;
}

export function createEmbeddedMessaging(options: EmbeddedMessagingOptions): EmbeddedMessaging {
  const stack: CoreStack = createCoreStack(options);

  return {
    getCapabilities(): CapabilityView {
      return stack.capabilities(EMBEDDED_PROTOCOL_VERSION);
    },

    authenticate(credential: unknown): Promise<EmbeddedAuthOutcome> {
      return stack.authenticate(credential);
    },

    async start(): Promise<void> {
      // DEC-21 (F10): the embedded root sweeps at startup too — accept-after-
      // sweep parity with the standalone root. Idempotent and safe with zero
      // pending; a torn acceptance from a previous run is re-driven before
      // the host serves. (The report stays available via runRecoverySweep.)
      await stack.runRecoverySweep();
      return stack.start();
    },

    pumpEvents(): Promise<void> {
      return stack.pumpEvents();
    },

    runRecoverySweep(): Promise<RecoverySweepReport> {
      return stack.runRecoverySweep();
    },

    async close(): Promise<void> {
      await stack.close();
    },

    clock: stack.clock,
    store: stack.store,
    authority: stack.authority,
    membership: stack.membership,
    transports: stack.transports,
    registry: stack.registry,
    bus: stack.bus,
  };
}

/** Re-exported config type so hosts compose through one surface. */
export type { AuthorityConfig, ConfigAuthority };

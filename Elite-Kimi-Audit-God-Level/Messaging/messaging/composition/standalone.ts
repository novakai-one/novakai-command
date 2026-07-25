/**
 * composition/standalone.ts — THE composition root for standalone mode
 * (Plan §17, DEC-17): the same core as embedded (ONE wiring — coreStack),
 * fronted by a versioned JSON-over-WebSocket protocol, with store-jsonl as
 * the production store. External Chiefs are the primary consumer (MSG-004/005,
 * MSG-023): they connect, authenticate, OpenPresence, Subscribe — and are
 * PUSHED TO, never polling.
 *
 * Mode differences (and the ONLY mode differences — adapters + arrival):
 *  - Store: store-jsonl at a configurable data path (production default, ADR-7).
 *  - Transport: presence-transport-ws over `ws` (real sockets, ping/pong
 *    liveness → the single presence-close path, R9).
 *  - Authority: authority-config — injected config OR a JSON config file
 *    (DEC-07 role→grant mapping lives in that config, never core).
 *  - The event bus tails the journal on a short interval (default 25 ms —
 *    the <1s push budget, MSG-023); event content is journal-sourced either
 *    way (emit-only-after-durable).
 *  - Revalidation (§2.1): the protocol layer runs the timer per connection.
 *
 * Startup order (documented choice): the DEC-21 recovery sweep runs BEFORE
 * the server accepts connections (accept-after-sweep) — an external Chief
 * never connects to a capability that hasn't re-driven its pending effects.
 * The sweep report is exposed on the handle as startup evidence.
 *
 * Graceful shutdown (close): close every live socket FIRST (each close raises
 * onDisconnect → the single presence-close path ends subscriptions with
 * best-effort ended{closed}) → server.close (stops accepting; resolves once
 * no clients remain) → stop the bus → close the store. The order is load-
 * bearing (F2): ws's server.close callback never fires while clients are
 * connected, so closing sockets must come first.
 */

import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { ClockIds } from "../seams/clock.js";
import type { Authority, ProvisioningDirectory } from "../seams/authority.js";
import type { RetryPolicy } from "../seams/presenceTransport.js";
import type { AuthorityConfig } from "../adapters/authority-config.js";
import { createSystemClock } from "../adapters/clock-system.js";
import { openJsonlStore } from "../adapters/store-jsonl.js";
import { createWsPresenceTransport } from "../adapters/presence-transport-ws.js";
import type { WsPresenceTransport } from "../adapters/presence-transport-ws.js";
import type { RecoverySweepReport } from "../core/recoverySweep.js";
import { createCoreStack } from "./coreStack.js";
import type { CoreStack } from "./coreStack.js";
import { createProtocolConnection } from "../protocol/connection.js";
import { WS_PROTOCOL_VERSION } from "../protocol/frames.js";

export const STANDALONE_PROTOCOL_VERSION = WS_PROTOCOL_VERSION;
export const DEFAULT_STANDALONE_PORT = 8787;
export const DEFAULT_STANDALONE_HOST = "127.0.0.1";
/** The MSG-023 push budget: the journal tail interval (well under 1 s). */
export const DEFAULT_BUS_POLL_INTERVAL_MS = 25;
/** DEC-21 periodic sweep cadence (Store-Seam §7: startup AND periodic — F11). */
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface StandaloneMessagingOptions {
  /** Injected authority config (DEC-07 mapping lives here, never core)… */
  authority?: AuthorityConfig | (Authority & ProvisioningDirectory);
  /** …or a JSON file carrying an AuthorityConfig. Exactly one of the two. */
  authorityConfigPath?: string;
  /** The store-jsonl journal file path (parent directories are created). */
  dataPath: string;
  /** WS listen port (default 8787; 0 = ephemeral, see handle.port). */
  port?: number;
  /** WS listen host (default 127.0.0.1). */
  host?: string;
  clock?: ClockIds;
  retryPolicy?: RetryPolicy;
  /** §2.1 degraded grace period (v1 default 5 min). */
  revalidateGraceMs?: number;
  /** Journal tail interval (default 25 ms). */
  busPollIntervalMs?: number;
  /** Per-subscription buffer bound (default constants.subscriptionBufferMax, R1). */
  subscriptionBufferMax?: number;
  /** Parked-frame retry cadence for transient push failures (default 250 ms). */
  pushRetryDelayMs?: number;
  /** WS ping/pong liveness cadence (default 30 s). */
  livenessIntervalMs?: number;
  /** Bounded effect deadline (default 5 s, Seams §4.3). */
  effectDeadlineMs?: number;
  /**
   * DEC-21 periodic sweep interval (Store-Seam §7: startup AND periodic —
   * F11). Unref'd timer; default DEFAULT_SWEEP_INTERVAL_MS; 0 disables.
   * Tests can always drive stack.runRecoverySweep() manually.
   */
  sweepIntervalMs?: number;
  /**
   * TEST-ONLY fault injection (F4): holds the send pipeline's commit→settle
   * window open so the W2 SIGKILL proof lands inside it deterministically.
   * Never set in production.
   */
  effectLegDelayMs?: number;
}

export interface StandaloneMessaging {
  /** The bound port (resolves port 0 to the ephemeral choice). */
  readonly port: number;
  readonly host: string;
  /** The DEC-21 startup sweep report (ran before accepting connections). */
  readonly sweep: RecoverySweepReport;
  /** Composition-owned handles (not contract surface). */
  readonly stack: CoreStack;
  readonly transport: WsPresenceTransport;
  close(): Promise<void>;
}

function loadAuthorityConfig(
  options: StandaloneMessagingOptions,
): AuthorityConfig | (Authority & ProvisioningDirectory) {
  if (options.authority !== undefined && options.authorityConfigPath !== undefined) {
    throw new Error("standalone config: pass authority OR authorityConfigPath, not both");
  }
  if (options.authorityConfigPath !== undefined) {
    // Adapter config from disk — createConfigAuthority validates the content
    // at construction (fail-fast, Seams §1).
    return JSON.parse(readFileSync(options.authorityConfigPath, "utf8")) as AuthorityConfig;
  }
  if (options.authority === undefined) {
    throw new Error("standalone config: an authority (config or config file) is required");
  }
  return options.authority;
}

export async function createStandaloneMessaging(
  options: StandaloneMessagingOptions,
): Promise<StandaloneMessaging> {
  const clock = options.clock ?? createSystemClock();
  const store = await openJsonlStore(clock, { path: options.dataPath });
  const transport = createWsPresenceTransport({
    ...(options.livenessIntervalMs !== undefined
      ? { livenessIntervalMs: options.livenessIntervalMs }
      : {}),
    ...(options.effectDeadlineMs !== undefined
      ? { effectDeadlineMs: options.effectDeadlineMs }
      : {}),
  });
  const stack = createCoreStack({
    authority: loadAuthorityConfig(options),
    clock,
    store,
    transports: [transport],
    busPollIntervalMs: options.busPollIntervalMs ?? DEFAULT_BUS_POLL_INTERVAL_MS,
    ...(options.retryPolicy !== undefined ? { retryPolicy: options.retryPolicy } : {}),
    ...(options.revalidateGraceMs !== undefined
      ? { revalidateGraceMs: options.revalidateGraceMs }
      : {}),
    ...(options.subscriptionBufferMax !== undefined
      ? { subscriptionBufferMax: options.subscriptionBufferMax }
      : {}),
    ...(options.pushRetryDelayMs !== undefined
      ? { pushRetryDelayMs: options.pushRetryDelayMs }
      : {}),
    sweepIntervalMs: options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    ...(options.effectLegDelayMs !== undefined
      ? { effectLegDelayMs: options.effectLegDelayMs }
      : {}),
  });

  // DEC-21: re-drive pending effects BEFORE accepting connections
  // (accept-after-sweep — documented choice; the sweep is idempotent and
  // safe with zero pending).
  const sweep = await stack.runRecoverySweep();
  await stack.start();

  const host = options.host ?? DEFAULT_STANDALONE_HOST;
  const server = new WebSocketServer({ port: options.port ?? DEFAULT_STANDALONE_PORT, host });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (error) => reject(error));
  });

  server.on("connection", (socket) => {
    transport.accept(socket);
    const connection = createProtocolConnection({
      stack,
      send: (frame) => {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // The socket died mid-send — the close event drives teardown.
        }
      },
      bindPresence: (presenceId) => transport.bind(presenceId, socket),
      pushSinkFor: (presenceId) => (frame) => transport.push(presenceId, frame),
      closeConnection: () => {
        try {
          socket.close(1000, "session ended");
        } catch {
          // Already closing — the close event drives teardown.
        }
      },
    });
    socket.on("message", (data: Buffer) => {
      void connection.handleText(data.toString("utf8"));
    });
    socket.on("close", () => {
      void connection.handleClose();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    host,
    sweep,
    stack,
    transport,

    async close(): Promise<void> {
      // F2: close live sockets FIRST. ws's server.close() callback never
      // fires while clients are connected, so awaiting it before closing
      // sockets deadlocks with any live client — closeAll() was unreachable.
      // Every socket close raises onDisconnect → the single presence-close
      // path ends subscriptions (best-effort ended{closed}); then
      // server.close() resolves promptly (no clients remain, and it stops
      // accepting new ones).
      await transport.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await stack.close();
    },
  };
}

/**
 * Adapter factories for the shared contract suites and the P5 swap proof.
 *
 * Extracted to a NON-TEST module so the suite files (store-contract.test.ts,
 * transport-contract.test.ts) and the P5 manifest (p5-adapter-swap.test.ts)
 * import the SAME factory arrays — the manifest can never drift from what
 * the suites actually run (importing a .test module would re-run its suites
 * in the importer's process).
 *
 * Every factory abstracts its adapter's construction/binding mechanics so
 * the shared suites never mention them (DEC-10: the suites pass unchanged
 * against every adapter).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import type { PresenceId } from "../../contract/index.js";
import type { MessagingStore } from "../../contract/ports/store.js";
import type { PresenceTransport } from "../../contract/ports/presence-transport.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { SeededClock } from "../../adapters/clock-seeded.js";
import { createMemoryStore } from "../../adapters/store-memory.js";
import { openJsonlStore } from "../../adapters/store-jsonl.js";
import { createMemoryPresenceTransport } from "../../adapters/presence-transport-memory.js";
import type { MemoryPresenceTransport } from "../../adapters/presence-transport-memory.js";
import { createPtyPresenceTransport } from "../../adapters/presence-transport-pty.js";
import type { PtyPresenceTransport } from "../../adapters/presence-transport-pty.js";
import { createWsPresenceTransport } from "../../adapters/presence-transport-ws.js";
import type { WsPresenceTransport } from "../../adapters/presence-transport-ws.js";
import { FakePtyChild } from "./fakePtyChild.js";

// --- store adapters -----------------------------------------------------------------

export interface StoreAdapterHandle {
  store: MessagingStore;
  clock: SeededClock;
  /** store-jsonl only: close and reopen against the same file (restart). */
  reopen?: () => Promise<MessagingStore>;
  cleanup: () => void;
}

export interface StoreAdapterFactory {
  name: string;
  make: () => Promise<StoreAdapterHandle>;
}

/** Both store adapters run the ONE shared store suite, unchanged (Store-Seam §8). */
export const storeAdapterFactories: StoreAdapterFactory[] = [
  {
    name: "store-memory",
    make: () => {
      const clock = createSeededClock({ seed: "mem" });
      return Promise.resolve({
        store: createMemoryStore(clock),
        clock,
        cleanup: () => {},
      });
    },
  },
  {
    name: "store-jsonl",
    make: async () => {
      const dir = mkdtempSync(join(tmpdir(), "nvk-messaging-store-"));
      const path = join(dir, "store.jsonl");
      const clock = createSeededClock({ seed: "jsonl" });
      const store = await openJsonlStore(clock, { path });
      let current = store;
      return {
        store,
        clock,
        reopen: async () => {
          await current.close();
          current = await openJsonlStore(clock, { path });
          return current;
        },
        cleanup: () => {
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

// --- presence-transport adapters ------------------------------------------------------

export interface TransportAdapterHandle {
  transport: PresenceTransport;
  /** Give the presence a LIVE lane (per-adapter mechanics, invisible to the suite). */
  bind(presenceId: PresenceId): Promise<void>;
  /** Kill the presence's lane (socket close / child exit / scripted). */
  killLane(presenceId: PresenceId): Promise<void>;
  /** What the far end observed, as parsed JSON, in arrival order where defined. */
  received(): unknown[];
  cleanup(): Promise<void>;
}

export interface TransportAdapterFactory {
  name: string;
  make: () => Promise<TransportAdapterHandle>;
}

async function ticks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeMemoryTransportFactory(): TransportAdapterFactory {
  return {
    name: "presence-transport-memory",
    make: () => {
      const transport: MemoryPresenceTransport = createMemoryPresenceTransport({ kind: "ws" });
      const liveLanes = new Set<PresenceId>();
      const deadLanes = new Set<PresenceId>();
      // Script: the adapter's routing table (it is a test double by design —
      // its "lane" is the script): a bound live lane effects; an unbound
      // presence is the transient bind window; a killed lane is gone.
      const report = (presenceId: PresenceId) => {
        if (deadLanes.has(presenceId)) {
          return { kind: "failure", retryable: false, detail: "lane is dead", permanent: "presence-gone" } as const;
        }
        if (!liveLanes.has(presenceId)) {
          return { kind: "failure", retryable: true, detail: `no lane bound to ${presenceId} (bind window or unbound)` } as const;
        }
        return { kind: "effect" } as const;
      };
      transport.setDeliverScript(report);
      transport.setPushScript((presenceId) => report(presenceId));
      return Promise.resolve({
        transport,
        bind: (presenceId) => {
          liveLanes.add(presenceId);
          return Promise.resolve();
        },
        killLane: (presenceId) => {
          liveLanes.delete(presenceId);
          deadLanes.add(presenceId);
          transport.simulateDisconnect(presenceId);
          return Promise.resolve();
        },
        received: () => [
          ...transport.effects.map((effect) => ({
            kind: "delivery",
            message: effect.payload.message,
            priority: effect.payload.priority,
            presenceId: effect.presenceId,
          })),
          ...transport.pushes.map((push) => push.frame),
        ],
        cleanup: () => Promise.resolve(),
      });
    },
  };
}

function makePtyTransportFactory(): TransportAdapterFactory {
  return {
    name: "presence-transport-pty",
    make: () => {
      const transport: PtyPresenceTransport = createPtyPresenceTransport({ livenessIntervalMs: 0 });
      const children = new Map<PresenceId, FakePtyChild>();
      return Promise.resolve({
        transport,
        bind: (presenceId) => {
          const child = new FakePtyChild();
          children.set(presenceId, child);
          assert.equal(transport.bind(presenceId, child), true, "bind a live fake child");
          return Promise.resolve();
        },
        killLane: async (presenceId) => {
          children.get(presenceId)?.exit(0);
          await ticks();
        },
        received: () => [...children.values()].flatMap((child) => child.receivedJson()),
        cleanup: () => transport.closeAll(),
      });
    },
  };
}

function makeWsTransportFactory(): TransportAdapterFactory {
  return {
    name: "presence-transport-ws",
    make: async () => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => wss.once("listening", resolve));
      const port = (wss.address() as AddressInfo).port;
      const receivedFrames: unknown[] = [];
      wss.on("connection", (socket) => {
        socket.on("message", (data) => {
          receivedFrames.push(JSON.parse(data.toString()) as unknown);
        });
      });
      const transport: WsPresenceTransport = createWsPresenceTransport({ livenessIntervalMs: 0 });
      const sockets = new Map<PresenceId, WebSocket>();
      return {
        transport,
        bind: async (presenceId) => {
          const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
          await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
          });
          transport.accept(socket);
          assert.equal(transport.bind(presenceId, socket), true, "bind a live socket");
          sockets.set(presenceId, socket);
        },
        killLane: async (presenceId) => {
          sockets.get(presenceId)?.close();
          await ticks();
        },
        received: () => receivedFrames,
        cleanup: async () => {
          await transport.closeAll();
          await new Promise<void>((resolve) => wss.close(() => resolve()));
        },
      };
    },
  };
}

/** Every transport adapter in the v1 suite runs the ONE shared transport suite, unchanged. */
export const transportAdapterFactories: TransportAdapterFactory[] = [
  makeMemoryTransportFactory(),
  makePtyTransportFactory(),
  makeWsTransportFactory(),
];

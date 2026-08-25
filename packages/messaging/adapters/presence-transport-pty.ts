/**
 * presence-transport-pty adapter (Messaging-Seams.md §4.3) — the PTY presence
 * transport: delivers by writing into a principal's terminal process (DEC-08's
 * "bytes into the PTY"; the MSG-008 urgent steer is simply `deliver` with
 * priority urgent — mechanics adapter-private, the core sees one contract).
 * ZERO new runtime deps: node:child_process spawn + stdin write.
 *
 * Mechanics (adapter-private, §4.1):
 *  - effect = the payload line was handed to the child's stdin and the write
 *    confirmed (write callback without error) — a REAL transport effect
 *    (G10). A bounded effect deadline (default 5 s, §4.3) turns a hung write
 *    into a transient failure, never a hung caller.
 *  - A child that has exited (or lost its stdin) reports permanent
 *    "presence-gone" (§4.1: the connection died — the presence closes, the
 *    Delivery stays pending per the R5 no-presence rule).
 *  - Liveness is process liveness (§4.1), reported, never inferred by the
 *    core: the child's exit raises onDisconnect for every Presence bound to
 *    it; the probe (signal-0, default 30 s — adapter config) raises
 *    onLivenessTimeout when the process can no longer be signalled, then the
 *    child is killed and untracked. Both callbacks funnel into the core's
 *    single presence-close path (R9).
 *
 * Binding (adapter-owned, beyond the seam — the analogue of the WS adapter's
 * accept/bind): a host binds a minted Presence to a child process it spawned
 * (bind), or asks the adapter to spawn one through the INJECTED spawn
 * function (open). The injectable spawn is the testable design: tests bind
 * fake children; production defaults to node:child_process.spawn. bind
 * returns false when the child is already gone (the spawn→bind window — the
 * caller then closes the minted Presence through the core's single close
 * path instead of leaking a ghost Presence, F10's PTY analogue). open owns
 * the spawn, so it surfaces the same window itself: a dead-on-arrival child
 * raises onDisconnect for the minted Presence immediately (audit F4).
 * closeAll SIGTERMs, waits a bounded grace, then SIGKILLs survivors
 * (audit F5).
 *
 * Wire shapes: `deliver` wraps the payload in the DEC-17 DeliveryFrame
 * (protocol/frames.ts — the inbound protocol's shared wire types; import
 * direction is adapter → protocol types only, never adapter → adapter);
 * `push` writes the SubscriptionMessage verbatim. Each frame is one JSON
 * line on the child's stdin.
 */

import { spawn } from "node:child_process";

import type { PresenceId, SubscriptionMessage } from "../contract/schemas.js";
import type { DeliveryFrame } from "../contract/standalone/frames.js";
import type {
  DeliverPayload,
  EffectReport,
  PresenceTransport,
  TransportLivenessCallbacks,
} from "../contract/ports/presence-transport.js";

/**
 * The slice of node:child_process's ChildProcess this adapter needs —
 * structural, so tests substitute a fake child and production passes the real
 * thing. Never a durable identity: the child is lane infrastructure (G2).
 */
export interface PtyChildStdin {
  write(chunk: string, callback: (error: Error | null | undefined) => void): boolean;
}

export interface PtyChildLike {
  readonly stdin: PtyChildStdin | null;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** Injectable spawn (§4.3 testability): production default is node:child_process.spawn. */
export type PtySpawn = (command: string, args: readonly string[]) => PtyChildLike;

const defaultSpawn: PtySpawn = (command, args) =>
  spawn(command, [...args], { stdio: ["pipe", "inherit", "inherit"] });

export interface PtyPresenceTransportOptions {
  /** Bounded effect deadline (default 5 s, §4.3). */
  effectDeadlineMs?: number;
  /** Process-liveness probe cadence (default 30 s; <= 0 disables — tests drive exit events directly). */
  livenessIntervalMs?: number;
  /**
   * closeAll grace (default 250 ms): the bounded wait for children to exit
   * after SIGTERM before survivors are SIGKILLed (audit F5).
   */
  closeGraceMs?: number;
  /** The spawn function (default node:child_process.spawn). */
  spawn?: PtySpawn;
}

export interface PtyPresenceTransport extends PresenceTransport {
  /**
   * Bind a minted Presence to a host-spawned child. Returns false when the
   * child is already gone (the spawn→bind window) — the caller MUST then
   * close the minted Presence through the core's single close path.
   */
  bind(presenceId: PresenceId, child: PtyChildLike): boolean;
  /** Spawn a child through the injected spawn function and bind it. */
  open(presenceId: PresenceId, command: string, args?: readonly string[]): PtyChildLike;
  /**
   * Graceful shutdown: SIGTERM every tracked child, wait a bounded grace
   * (closeGraceMs) for exit, SIGKILL the survivors (audit F5); the probe
   * stops. Never hangs — the grace timer is unref'd and every child is
   * untracked either way.
   */
  closeAll(): Promise<void>;
  /** Count of tracked children (operability/tests). */
  readonly childCount: number;
}

interface TrackedChild {
  child: PtyChildLike;
  /** Presences bound to this child. */
  presences: Set<PresenceId>;
}

export function createPtyPresenceTransport(options?: PtyPresenceTransportOptions): PtyPresenceTransport {
  const effectDeadlineMs = options?.effectDeadlineMs ?? 5_000;
  const livenessIntervalMs = options?.livenessIntervalMs ?? 30_000;
  const closeGraceMs = options?.closeGraceMs ?? 250;
  const doSpawn = options?.spawn ?? defaultSpawn;

  const tracked = new Map<PtyChildLike, TrackedChild>();
  const byPresence = new Map<PresenceId, PtyChildLike>();
  let liveness: TransportLivenessCallbacks | undefined;
  let livenessTimer: NodeJS.Timeout | undefined;

  /** The child can no longer receive anything: exited, killed, or stdin gone. */
  function childGone(child: PtyChildLike): boolean {
    return child.exitCode !== null || child.killed || child.stdin === null;
  }

  /**
   * Bounded grace for children to exit on their own (after SIGTERM). The
   * timer is unref'd and the wait resolves the moment every child is gone —
   * closeAll never hangs and never holds the event loop open (audit F5).
   */
  function waitForExit(children: PtyChildLike[], graceMs: number): Promise<void> {
    const remaining = new Set(children.filter((child) => !childGone(child)));
    if (remaining.size === 0 || graceMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, graceMs);
      timer.unref?.();
      for (const child of remaining) {
        child.on("exit", () => {
          remaining.delete(child);
          if (remaining.size === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
      }
    });
  }

  function untrack(child: PtyChildLike): void {
    const entry = tracked.get(child);
    if (entry === undefined) return;
    tracked.delete(child);
    for (const presenceId of entry.presences) {
      byPresence.delete(presenceId);
      // The single presence-close path (R9) — the core closes, ends
      // subscriptions, emits the PresenceChanged observation.
      liveness?.onDisconnect(presenceId);
    }
    entry.presences.clear();
  }

  function writeLine(child: PtyChildLike, payload: unknown): Promise<EffectReport> {
    return new Promise((resolve) => {
      const stdin = child.stdin;
      if (stdin === null || childGone(child)) {
        resolve({
          kind: "failure",
          retryable: false,
          detail: "the child process is gone — the connection died",
          permanent: "presence-gone",
        });
        return;
      }
      let settled = false;
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        // §4.3 bounded effect deadline: a hung write is a transient failure,
        // never a hung caller.
        resolve({ kind: "failure", retryable: true, detail: "effect deadline exceeded" });
      }, effectDeadlineMs);
      try {
        stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          if (error) {
            const gone = childGone(child);
            resolve({
              kind: "failure",
              retryable: !gone,
              detail: `pty stdin write failed: ${error.message}`,
              ...(gone ? { permanent: "presence-gone" as const } : {}),
            });
          } else {
            // Bytes into the PTY — a REAL effect (G10/DEC-08).
            resolve({ kind: "effect" });
          }
        });
      } catch (cause) {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve({
          kind: "failure",
          retryable: false,
          detail: `pty stdin write threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          permanent: "presence-gone",
        });
      }
    });
  }

  function startLiveness(): void {
    if (livenessTimer !== undefined || livenessIntervalMs <= 0) return;
    livenessTimer = setInterval(() => {
      for (const entry of [...tracked.values()]) {
        let signalable = !childGone(entry.child);
        if (signalable) {
          try {
            // Signal-0 probe: succeeds iff the process exists.
            entry.child.kill(0);
          } catch {
            signalable = false;
          }
        }
        if (signalable) continue;
        // The probe failed: report, kill, and let untrack raise onDisconnect
        // for the bound Presences (the WS adapter's exact choreography).
        for (const presenceId of entry.presences) {
          liveness?.onLivenessTimeout(presenceId);
        }
        try {
          entry.child.kill();
        } catch {
          // Already gone — untrack below is the honest teardown either way.
        }
        untrack(entry.child);
      }
    }, livenessIntervalMs);
    livenessTimer.unref?.();
  }

  function attach(presenceId: PresenceId, child: PtyChildLike): boolean {
    if (childGone(child)) {
      // The spawn→bind window: the child died before the Presence could be
      // bound. The caller MUST close the minted Presence through the single
      // close path; silently returning leaked a ghost Presence (F10).
      return false;
    }
    let entry = tracked.get(child);
    if (entry === undefined) {
      entry = { child, presences: new Set() };
      tracked.set(child, entry);
      child.on("exit", () => {
        untrack(child);
      });
      child.on("error", () => {
        // Spawn/exec failure surfaces here on a real ChildProcess (ENOENT);
        // the lane is dead — the same teardown as an exit.
        untrack(child);
      });
    }
    entry.presences.add(presenceId);
    byPresence.set(presenceId, child);
    return true;
  }

  return {
    kind: "pty",

    get childCount(): number {
      return tracked.size;
    },

    attachLiveness(callbacks: TransportLivenessCallbacks): void {
      liveness = callbacks;
      startLiveness();
    },

    bind(presenceId: PresenceId, child: PtyChildLike): boolean {
      return attach(presenceId, child);
    },

    open(presenceId: PresenceId, command: string, args: readonly string[] = []): PtyChildLike {
      const child = doSpawn(command, args);
      if (!attach(presenceId, child)) {
        // The spawn→bind window hit on an ADAPTER-OWNED spawn (audit F4):
        // bind() reports false and leaves the close to the caller, but open
        // has no caller-side handle on the minted Presence's lifecycle — so
        // open surfaces the failure itself by raising onDisconnect, the same
        // report a child that died a tick later would produce. The minted
        // Presence funnels into the core's single close path (R9); no ghost.
        liveness?.onDisconnect(presenceId);
      }
      return child;
    },

    async deliver(presenceId: PresenceId, payload: DeliverPayload): Promise<EffectReport> {
      const child = byPresence.get(presenceId);
      if (child === undefined) {
        // Unbound ≠ gone (the open→retrigger→bind window — the registry's
        // opened-listeners fire before a host can bind): a TRANSIENT failure,
        // retried inside the R5 budget. A real disconnect arrives via
        // untrack → onDisconnect.
        return {
          kind: "failure",
          retryable: true,
          detail: `no child process bound to ${presenceId} (bind window or unbound)`,
        };
      }
      const frame: DeliveryFrame = {
        kind: "delivery",
        message: payload.message,
        priority: payload.priority,
        presenceId,
      };
      return writeLine(child, frame);
    },

    async push(presenceId: PresenceId, frame: SubscriptionMessage): Promise<EffectReport> {
      const child = byPresence.get(presenceId);
      if (child === undefined) {
        // As deliver: unbound ≠ gone; a transient report parks the frame in
        // the subscription buffer (Seams §4.2).
        return {
          kind: "failure",
          retryable: true,
          detail: `no child process bound to ${presenceId} (bind window or unbound)`,
        };
      }
      // OBSERVATION lane (R2): the SubscriptionMessage crosses verbatim.
      return writeLine(child, frame);
    },

    async closeAll(): Promise<void> {
      if (livenessTimer !== undefined) {
        clearInterval(livenessTimer);
        livenessTimer = undefined;
      }
      const children = [...tracked.keys()];
      for (const child of children) {
        try {
          child.kill(); // SIGTERM — the graceful ask
        } catch {
          // Already gone — untrack below is the honest teardown either way.
        }
      }
      // Audit F5: SIGTERM is only a request. Give the children a BOUNDED
      // grace to actually exit, then SIGKILL the survivors — a shutdown never
      // leaves a tracked process alive behind a closed transport (the WS
      // adapter's close→guard→terminate choreography, mirrored for PTY).
      await waitForExit(children, closeGraceMs);
      for (const child of children) {
        if (!childGone(child)) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone between the grace and the escalation — fine.
          }
        }
        untrack(child);
      }
      // closeAll raises onDisconnect per bound Presence via untrack (or the
      // exit events during the grace); the core's single close path handles
      // the rest (R9). The Promise shape mirrors the WS adapter's closeAll so
      // composition roots can await either transport uniformly.
    },
  };
}

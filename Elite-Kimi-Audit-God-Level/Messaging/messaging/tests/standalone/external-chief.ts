/**
 * external-chief — THE external Chief client for the S1-d proofs (P2/P3/W2,
 * MSG-004). It speaks ONLY the published DEC-17 wire protocol: JSON frames
 * over a WebSocket. It imports NOTHING from the messaging capability at
 * runtime — the only imports are `ws` and type-only references to the
 * published frame shapes (erased at compile time; the architecture suite
 * asserts the compiled file imports no messaging module). No Novakai-specific
 * object is needed to provision, authenticate, send, receive, or subscribe:
 * identity is a bearer token issued by the authority config; everything else
 * is the wire protocol.
 *
 * Frame vocabulary (from the published protocol, protocol/frames.ts):
 *   client → server: get-capabilities · authenticate · command · query ·
 *                    subscribe · unsubscribe
 *   server → client: capabilities · authenticated · command-result ·
 *                    query-result · delivery (ADDRESSED lane) · error ·
 *                    started/event/ended (OBSERVATION lane, contract stream)
 */

import WebSocket from "ws";
import type { ClientFrame } from "../../public/index.js";

/**
 * A received frame, read structurally: the server→client vocabulary is the
 * published envelopes (capabilities · authenticated · command-result ·
 * query-result · delivery · error) plus the subscription stream frames
 * (started/event/ended — contract shapes, R1) crossing verbatim.
 */
type Frame = Record<string, unknown>;

export interface ExternalCommandError {
  name: string;
  message: string;
  retryable: boolean;
  fields: Record<string, unknown>;
}

export type ExternalCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: ExternalCommandError };

interface Waiter {
  match: (frame: Frame) => boolean;
  resolve: (frame: Frame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ExternalChief {
  private readonly socket: WebSocket;
  private readonly backlog: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  private requestCounter = 0;
  /** The authenticated principal's Person ID, as returned by the handshake. */
  personId: string | undefined;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString("utf8")) as Frame;
      const index = this.waiters.findIndex((waiter) => waiter.match(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter?.timer as NodeJS.Timeout);
        waiter?.resolve(frame);
      } else {
        this.backlog.push(frame);
      }
    });
  }

  static async connect(port: number, host = "127.0.0.1"): Promise<ExternalChief> {
    const socket = new WebSocket(`ws://${host}:${port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    return new ExternalChief(socket);
  }

  /** Send one client frame verbatim (the whole client vocabulary is public). */
  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Await the next frame matching `match` (backlog first; consumed on match). */
  waitFor(match: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    const index = this.backlog.findIndex(match);
    if (index >= 0) {
      const [frame] = this.backlog.splice(index, 1);
      return Promise.resolve(frame as Frame);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("external-chief: timed out waiting for frame"));
      }, timeoutMs);
      this.waiters.push({ match, resolve, reject, timer });
    });
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${this.requestCounter}`;
  }

  /** Send a request frame and await ANY correlated response (result or error). */
  private async call(frame: ClientFrame & { requestId: string }): Promise<Frame> {
    this.send(frame);
    return this.waitFor((candidate) => candidate["requestId"] === frame.requestId);
  }

  /** Pre-authentication discovery (R3): versions and limits, nothing else. */
  async getCapabilities(): Promise<Record<string, unknown>> {
    this.send({ kind: "get-capabilities" });
    const frame = await this.waitFor((candidate) => candidate["kind"] === "capabilities");
    return frame["capabilities"] as Record<string, unknown>;
  }

  /**
   * The auth handshake. credential is opaque to the client vocabulary — the
   * authority config decides what a credential is (v1: { token }).
   */
  async authenticate(token: string, protocolVersion?: string): Promise<ExternalCallResult> {
    const frame = await this.call({
      kind: "authenticate",
      requestId: this.nextRequestId("auth"),
      credential: { token },
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    });
    if (frame["kind"] === "error") {
      return { ok: false, error: frame["error"] as ExternalCommandError };
    }
    const principal = frame["principal"] as { personId: string };
    this.personId = principal.personId;
    return { ok: true, result: principal };
  }

  async command(name: string, input: unknown): Promise<ExternalCallResult> {
    const frame = await this.call({
      kind: "command",
      requestId: this.nextRequestId("cmd"),
      name: name as never,
      input,
    });
    if (frame["kind"] === "error") {
      return { ok: false, error: frame["error"] as ExternalCommandError };
    }
    return { ok: true, result: frame["result"] };
  }

  async query(name: string, input: unknown): Promise<ExternalCallResult> {
    const frame = await this.call({
      kind: "query",
      requestId: this.nextRequestId("qry"),
      name: name as never,
      input,
    });
    if (frame["kind"] === "error") {
      return { ok: false, error: frame["error"] as ExternalCommandError };
    }
    return { ok: true, result: frame["result"] };
  }

  /** OpenPresence over the ws transport; returns the minted Presence ID. */
  async openPresence(clientLabel = "external-chief"): Promise<string> {
    const outcome = await this.command("OpenPresence", { transport: "ws", clientLabel });
    if (!outcome.ok) throw new Error(`OpenPresence failed: ${outcome.error.message}`);
    return (outcome.result as { presenceId: string }).presenceId;
  }

  /**
   * Subscribe (R1): the STREAM acknowledges — the `started` frame carries the
   * subscriptionId. Events arrive pushed; the client never polls.
   */
  async subscribe(events: string[], since?: string): Promise<string> {
    this.send({
      kind: "subscribe",
      requestId: this.nextRequestId("sub"),
      input: { events, ...(since !== undefined ? { since } : {}) },
    });
    const started = await this.waitFor(
      (frame) => frame["kind"] === "started" && typeof frame["subscriptionId"] === "string",
    );
    return started["subscriptionId"] as string;
  }

  /** Await a pushed ADDRESSED-lane delivery (MSG-023: never polled). */
  waitForDelivery(match?: (message: Record<string, unknown>) => boolean): Promise<Frame> {
    return this.waitFor(
      (frame) =>
        frame["kind"] === "delivery" &&
        (match === undefined || match(frame["message"] as Record<string, unknown>)),
    );
  }

  /** Await a pushed OBSERVATION-lane subscription event (MSG-023). */
  waitForEvent(match?: (event: Record<string, unknown>) => boolean): Promise<Frame> {
    return this.waitFor(
      (frame) =>
        frame["kind"] === "event" &&
        (match === undefined || match(frame["event"] as Record<string, unknown>)),
    );
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const done = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await done;
  }
}

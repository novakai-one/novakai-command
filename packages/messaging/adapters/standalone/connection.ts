/** Serialized standalone connection lifecycle and protocol dispatch. */

import { MessagingError } from "../../contract/schemas.js";
import type { MessagingSession } from "../../contract/api.js";
import type { SubscriptionHandle, SubscriptionSink } from "../../contract/subscriptions.js";
import type { PresenceId } from "../../contract/schemas.js";
import type { CoreStack } from "../../contract/compose/stack.js";
import {
  authenticateClient,
  dispatchClientCommand,
  dispatchClientQuery,
  unexpectedInternalError,
} from "./client.js";
import { errorFrame, parseClientFrame } from "../../contract/standalone/frame-schemas.js";
import { WS_PROTOCOL_VERSION } from "../../contract/standalone/frames.js";
import type { AuthenticateFrame, ClientFrame, CommandFrame, QueryFrame,
  ServerFrame, SubscribeFrame, UnsubscribeFrame } from "../../contract/standalone/frames.js";

export interface ProtocolConnectionDeps {
  stack: CoreStack;
  /** Outbound frames — the caller serializes and writes to the socket. */
  send: (frame: ServerFrame) => void;
  /**
   * Wire a Presence to this connection's socket in the transport adapter.
   * Returns false when the socket is already gone (F10: the accept→bind
   * window) — the caller then closes the minted Presence through the single
   * close path instead of leaking it.
   */
  bindPresence: (presenceId: PresenceId) => boolean;
  /**
   * The push sink for a Presence-bound subscription — standalone binds
   * `transport.push(presenceId, frame)` (Seams §4.1 push lane; the
   * SubscriptionMessage crosses verbatim, serialized by the transport).
   */
  pushSinkFor: (presenceId: PresenceId) => SubscriptionSink;
  /** Close the underlying connection (session death, §2.1). */
  closeConnection: () => void;
  /** Degraded-revalidation retry cadence (default 30 s). */
  revalidateRetryMs?: number;
}

export interface ProtocolConnection {
  handleText(raw: string): Promise<void>;
  handleClose(): Promise<void>;
  readonly presenceId: PresenceId | undefined;
}

export function createProtocolConnection(deps: ProtocolConnectionDeps): ProtocolConnection {
  const { stack, send } = deps;
  const revalidateRetryMs = deps.revalidateRetryMs ?? 30_000;

  let session: MessagingSession | undefined;
  let presenceId: PresenceId | undefined;
  const handles = new Map<string, SubscriptionHandle>();
  let revalidateTimer: NodeJS.Timeout | undefined;
  let closed = false;
  /** F8: the per-connection frame-handling chain — ordered transport, ordered execution. */
  let frameChain: Promise<void> = Promise.resolve();

  function sendError(error: MessagingError, requestId?: string): void {
    send(errorFrame(error, requestId));
  }

  function notAuthenticated(requestId?: string): void {
    sendError(
      new MessagingError("NotAuthenticated", {
        message: "authenticate first — no live session on this connection",
        retryable: false,
        fields: {},
      }),
      requestId,
    );
  }

  /** §2.1 standalone half: the per-connection revalidation timer. */
  function scheduleRevalidation(): void {
    if (revalidateTimer !== undefined) clearTimeout(revalidateTimer);
    if (session === undefined || closed) return;
    const delayMs = Math.max(Date.parse(session.principal.expiresAt) - Date.now(), 0);
    revalidateTimer = setTimeout(() => {
      void (async () => {
        if (session === undefined || closed) return;
        const state = await session.revalidate();
        if (state === "active") {
          scheduleRevalidation(); // fresh expiresAt from the revalidated principal
          return;
        }
        if (state === "degraded") {
          // §2.1 degraded: subscriptions keep flowing; the session guard
          // blocks new operations; retry on the degraded cadence.
          revalidateTimer = setTimeout(() => scheduleRevalidation(), revalidateRetryMs);
          revalidateTimer.unref?.();
          return;
        }
        // ended: onEnded already terminated subscriptions (ended{auth-lost}).
        sendError(
          new MessagingError("NotAuthenticated", {
            message: "session is no longer valid — connection closing (§2.1)",
            retryable: false,
            fields: {},
          }),
        );
        deps.closeConnection();
      })().catch(() => {
        // A revalidation throw is an authority-adapter bug; the session guard
        // stays the honest gate. Retry on the degraded cadence.
        if (!closed) {
          revalidateTimer = setTimeout(() => scheduleRevalidation(), revalidateRetryMs);
          revalidateTimer.unref?.();
        }
      });
    }, delayMs);
    revalidateTimer.unref?.();
  }

  async function handleAuthenticate(frame: AuthenticateFrame): Promise<void> {
    const authenticated = await authenticateClient(stack, frame, sendError, (nextSession) => {
      send({
        kind: "authenticated",
        requestId: frame.requestId,
        principal: {
          personId: nextSession.principal.personId,
          grants: nextSession.principal.grants,
          expiresAt: nextSession.principal.expiresAt,
        },
      });
    });
    if (authenticated === undefined) return;
    session = authenticated.session;
    scheduleRevalidation();
  }

  async function handleCommand(frame: CommandFrame): Promise<void> {
    if (session === undefined) return notAuthenticated(frame.requestId);
    const dispatched = await dispatchClientCommand({
      session,
      stack,
      frame,
      bindPresence: deps.bindPresence,
    });
    if (dispatched.presenceId !== undefined) presenceId = dispatched.presenceId;
    if (dispatched.outcome.kind === "ok") {
      send({ kind: "command-result", requestId: frame.requestId, name: frame.name, result: dispatched.outcome.value });
    } else {
      sendError(dispatched.outcome.error, frame.requestId);
    }
  }

  async function handleQuery(frame: QueryFrame): Promise<void> {
    if (session === undefined) return notAuthenticated(frame.requestId);
    const outcome = await dispatchClientQuery(session, frame);
    if (outcome.kind === "ok") {
      send({ kind: "query-result", requestId: frame.requestId, name: frame.name, result: outcome.value });
    } else {
      sendError(outcome.error, frame.requestId);
    }
  }

  async function handleSubscribe(frame: SubscribeFrame): Promise<void> {
    if (session === undefined) return notAuthenticated(frame.requestId);
    if (presenceId === undefined) {
      // Subscribe binds its push lane + teardown to the connection's Presence
      // (documented choice) — OpenPresence first (R9).
      sendError(
        new MessagingError("ValidationFailed", {
          message: "validation failed: presence: Subscribe requires an open Presence on this connection — OpenPresence first (R9)",
          retryable: false,
          fields: {
            issues: [
              { path: "presence", message: "no open Presence on this connection (OpenPresence first)" },
            ],
          },
        }),
        frame.requestId,
      );
      return;
    }
    const boundPresence = presenceId;
    const outcome = await session.subscribe(frame.input, deps.pushSinkFor(boundPresence), {
      presenceId: boundPresence,
    });
    if (outcome.kind === "error") {
      sendError(outcome.error, frame.requestId);
      return;
    }
    // Success is acknowledged BY THE STREAM (started carries subscriptionId,
    // R1) — there is no separate ack frame. Track the handle for unsubscribe.
    handles.set(outcome.value.subscriptionId, outcome.value);
  }

  async function handleUnsubscribe(frame: UnsubscribeFrame): Promise<void> {
    const handle = handles.get(frame.subscriptionId);
    if (handle !== undefined) {
      handles.delete(frame.subscriptionId);
      await handle.close(); // ends with ended{closed} — the stream's own ack
    }
    // Unknown subscriptionId: idempotent no-op (mirrors ClosePresence, R9).
  }

  async function dispatch(frame: ClientFrame): Promise<void> {
    switch (frame.kind) {
      case "get-capabilities":
        send({ kind: "capabilities", capabilities: stack.capabilities(WS_PROTOCOL_VERSION) });
        return;
      case "authenticate":
        return handleAuthenticate(frame);
      case "command":
        return handleCommand(frame);
      case "query":
        return handleQuery(frame);
      case "subscribe":
        return handleSubscribe(frame);
      case "unsubscribe":
        return handleUnsubscribe(frame);
    }
  }

  return {
    get presenceId(): PresenceId | undefined {
      return presenceId;
    },

    async handleText(raw: string): Promise<void> {
      // F8: serialize frame handling per connection. A pipelined pair (e.g.
      // OpenPresence→Subscribe) executes in arrival order — pre-fix both
      // dispatches ran concurrently and the Subscribe could read presenceId
      // before the OpenPresence dispatch assigned it.
      const run = frameChain.then(() => processText(raw));
      frameChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    async handleClose(): Promise<void> {
      // Chain behind any in-flight frame handling (F8) so teardown never
      // races a dispatch.
      const run = frameChain.then(() => closeInner());
      frameChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  async function processText(raw: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      sendError(
        new MessagingError("ValidationFailed", {
          message: "validation failed: $: frame is not valid JSON",
          retryable: false,
          fields: { issues: [{ path: "$", message: "frame is not valid JSON" }] },
        }),
      );
      return;
    }
    const parsed = parseClientFrame(parsedJson);
    if (!parsed.ok) {
      sendError(parsed.error, parsed.requestId);
      return;
    }
    try {
      await dispatch(parsed.frame);
    } catch (cause) {
      // session.run converts MessagingError; a throw here is a core bug —
      // surface a typed frame, never crash the connection (G6).
      const requestId = "requestId" in parsed.frame ? parsed.frame.requestId : undefined;
      sendError(unexpectedInternalError(cause), requestId);
    }
  }

  async function closeInner(): Promise<void> {
    closed = true;
    if (revalidateTimer !== undefined) clearTimeout(revalidateTimer);
    // F10: close this connection's Presence through the single close path —
    // even one that was never bound to a socket (the accept→bind window),
    // which the transport's untrack → onDisconnect path cannot see. Bound
    // Presences are already closing via onDisconnect; closePath is
    // idempotent (R9), so the double close is a no-op.
    if (presenceId !== undefined) {
      await stack.registry.closePath(presenceId).catch(() => {});
      presenceId = undefined;
    }
    // Presence teardown (Seams §4.1) ends Presence-bound subscriptions via
    // the registry close path — the transport raises onDisconnect. Close
    // any remaining handles defensively (end() is idempotent).
    for (const handle of handles.values()) {
      await handle.close().catch(() => {});
    }
    handles.clear();
  }
}

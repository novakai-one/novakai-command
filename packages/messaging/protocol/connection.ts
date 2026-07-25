/**
 * protocol/connection — one DEC-17 protocol connection: frame parse →
 * session dispatch → correlated response. Transport-agnostic by injection
 * (the composition root supplies `send`, presence binding, and the push-sink
 * factory); the WS socket itself is owned by composition/standalone.ts and
 * adapters/presence-transport-ws.ts.
 *
 * Discipline:
 *  - MSG-021: malformed input produces a typed error frame, NEVER a throw
 *    and NEVER a dropped connection (a bad frame is a client bug, not a
 *    server event).
 *  - The auth handshake carries credentials (DEC-17). Authentication alone
 *    NEVER registers a Presence (R9) — OpenPresence is an explicit command
 *    here as everywhere.
 *  - Subscribe binds to the connection's CURRENT Presence (the most recent
 *    OpenPresence on this connection — documented choice): the push sink is
 *    `transport.push(presenceId, frame)` and the §4.1 teardown ends the
 *    subscription when that Presence closes. Subscribe before OpenPresence
 *    fails ValidationFailed{presence} — Subscribe's error catalogue has no
 *    no-presence shape (recorded ambiguity).
 *  - Revalidation (§2.1, standalone half): the composition root owns the
 *    revalidation timer — here, per connection: fires at expiresAt, treats
 *    "ended" as session death (subscriptions get ended{auth-lost} via the
 *    session's onEnded hook, then the connection closes), retries on the
 *    degraded cadence while the session guard blocks new operations.
 *  - Frame handling is SERIALIZED per connection (F8): an ordered transport
 *    must preserve execution order. Every inbound frame runs on a
 *    per-connection promise chain, so a pipelined OpenPresence→Subscribe
 *    pair executes in arrival order — the Subscribe always observes the
 *    Presence the earlier frame minted.
 *  - Presence lifetime is tied to the connection (F10): if the socket died
 *    before bind() (accept→bind window), the minted Presence is closed
 *    through the single close path and the command fails honestly — no
 *    ghost Presence. handleClose closes the connection's Presence too, so
 *    even a never-bound Presence cannot leak.
 */

import { MessagingError } from "../public/contract/index.js";
import type { MessagingSession, Outcome, SubscriptionSink } from "../public/capability.js";
import type { PresenceId, SubscriptionId } from "../public/contract/index.js";
import type { SubscriptionHandle } from "../core/subscriptions.js";
import type { CoreStack } from "../composition/coreStack.js";
import {
  errorFrame,
  parseClientFrame,
  WS_PROTOCOL_VERSION,
} from "./frames.js";
import type {
  AuthenticateFrame,
  ClientFrame,
  CommandFrame,
  QueryFrame,
  ServerFrame,
  SubscribeFrame,
  UnsubscribeFrame,
} from "./frames.js";

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
  /** One inbound text message. Never throws. */
  handleText(raw: string): Promise<void>;
  /** The socket is gone: clear timers and end this connection's subscriptions. */
  handleClose(): Promise<void>;
  /** The presence this connection's subscriptions are bound to, if any. */
  readonly presenceId: PresenceId | undefined;
}

/**
 * F9: a non-MessagingError throw at the protocol edge is an INTERNAL failure,
 * never infrastructure the client should wait on. The pre-fix mapping sent
 * DependencyUnavailable{retryable:true} with NO dependency field — a frozen-
 * shape violation that laundered core bugs into "retry me" signals.
 * The catalogue has no internal-error shape, so the honest mapping is
 * DependencyUnavailable with retryable:false and dependency "internal":
 * the dependency field is open-typed (additive extension is the
 * compatibility rule) and the tolerate-unknown rule makes consumers treat
 * it as non-retryable — exactly what an internal failure is.
 */
function unexpectedInternalError(cause: unknown): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: `unexpected internal error: ${cause instanceof Error ? cause.message : String(cause)}`,
    retryable: false,
    fields: { dependency: "internal", retryable: false },
  });
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
    // DEC-17 version negotiation at the handshake.
    if (frame.protocolVersion !== undefined && frame.protocolVersion !== WS_PROTOCOL_VERSION) {
      sendError(
        new MessagingError("VersionUnsupported", {
          message: `protocol version ${frame.protocolVersion} is not supported by this server`,
          retryable: false,
          fields: { supported: [WS_PROTOCOL_VERSION] },
        }),
        frame.requestId,
      );
      return;
    }
    const outcome = await stack.authenticate(frame.credential);
    if (outcome.kind !== "authenticated") {
      sendError(outcome.error, frame.requestId);
      return;
    }
    session = outcome.session;
    send({
      kind: "authenticated",
      requestId: frame.requestId,
      principal: {
        personId: outcome.principal.personId,
        grants: outcome.principal.grants,
        expiresAt: outcome.principal.expiresAt,
      },
    });
    scheduleRevalidation();
  }

  async function handleCommand(frame: CommandFrame): Promise<void> {
    if (session === undefined) return notAuthenticated(frame.requestId);
    let outcome: Outcome<unknown>;
    switch (frame.name) {
      case "SendMessage":
        outcome = await session.sendMessage(frame.input);
        break;
      case "SendFromTemplate":
        outcome = await session.sendFromTemplate(frame.input);
        break;
      case "OpenPresence": {
        const opened = await session.openPresence(frame.input);
        if (opened.kind === "ok") {
          // The connection's CURRENT presence (documented choice): the most
          // recent OpenPresence binds subscriptions and the transport lane.
          const bound = deps.bindPresence(opened.value.presenceId);
          if (!bound) {
            // F10: the socket died between accept and bind — close the
            // minted Presence through the SINGLE close path so it never
            // ghosts (GetPresence would show it; deliveries would burn
            // retry budget against a dead lane). The command fails
            // honestly: OpenPresence's catalogue is NotAuthenticated +
            // DependencyUnavailable; the dependency field is open-typed
            // (tolerate-unknown → non-retryable), and "presence-transport"
            // names the failing seam. (The seam doc's deliberate-absence
            // ruling covers DELIVERY failures, which surface as typed
            // Delivery state; there is no Delivery here.)
            await stack.registry.closePath(opened.value.presenceId);
            outcome = {
              kind: "error",
              error: new MessagingError("DependencyUnavailable", {
                message: "the connection's socket died before the Presence could be bound — the Presence was closed",
                retryable: false,
                fields: { dependency: "presence-transport", retryable: false },
              }),
            };
            break;
          }
          presenceId = opened.value.presenceId;
        }
        outcome = opened;
        break;
      }
      case "ClosePresence":
        outcome = await session.closePresence(frame.input);
        break;
      case "SetDndPolicy":
        outcome = await session.setDndPolicy(frame.input);
        break;
      case "SetContactPolicy":
        outcome = await session.setContactPolicy(frame.input);
        break;
      case "UpsertTemplate":
        outcome = await session.upsertTemplate(frame.input);
        break;
      case "RetireTemplate":
        outcome = await session.retireTemplate(frame.input);
        break;
    }
    if (outcome.kind === "ok") {
      send({ kind: "command-result", requestId: frame.requestId, name: frame.name, result: outcome.value });
    } else {
      sendError(outcome.error, frame.requestId);
    }
  }

  async function handleQuery(frame: QueryFrame): Promise<void> {
    if (session === undefined) return notAuthenticated(frame.requestId);
    let outcome: Outcome<unknown>;
    switch (frame.name) {
      case "GetThread":
        outcome = await session.getThread(frame.input);
        break;
      case "ListThreadsForPerson":
        outcome = await session.listThreadsForPerson(frame.input);
        break;
      case "GetMessages":
        outcome = await session.getMessages(frame.input);
        break;
      case "GetInbox":
        outcome = await session.getInbox(frame.input);
        break;
      case "GetDelivery":
        outcome = await session.getDelivery(frame.input);
        break;
      case "GetPolicy":
        outcome = await session.getPolicy(frame.input);
        break;
      case "ListTemplates":
        outcome = await session.listTemplates(frame.input);
        break;
      case "GetPresence":
        outcome = await session.getPresence(frame.input);
        break;
    }
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

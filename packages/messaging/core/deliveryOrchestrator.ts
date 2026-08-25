/**
 * deliveryOrchestrator — the R5 delivery state machine in motion.
 *
 * Runs the attempt decision points the frozen machine names:
 *   - acceptance: sendPipeline hands each committed Delivery here;
 *   - presence-open re-trigger: every PresenceChanged(opened) for a recipient
 *     re-triggers attempt decisions for their pending Deliveries (R5
 *     no-presence rule);
 *   - DND release: SetDndPolicy(enabled=false) releases every held Delivery
 *     for that Person back to pending (held → pending, dnd-released) and
 *     normal attempts resume;
 *   - retry: a retryable transport failure reschedules within the bounded
 *     budget (v1 default 5 attempts, backoff); exhaustion →
 *     failed{retry-exhausted}.
 *
 * Machine discipline (frozen):
 *   - Policy (DND) is re-evaluated at EVERY decision point against CURRENT
 *     store state — never a value cached from acceptance.
 *   - delivered settles ONLY on a real adapter effect (DEC-08, G10, I11), via
 *     the store CAS; the DEC-16 fan-out race resolves there — first effect
 *     wins, late effects are recorded as superseded attempts.
 *   - Zero live Presences leaves the Delivery pending — never failed.
 *   - held has no failure transitions; it exits only via dnd-released or
 *     in-flight-effect (an attempt started before the hold reports a real
 *     effect: held → delivered, adapter-effect).
 *   - Transport failures are typed Delivery state, never command errors
 *     (Seams §4.2).
 *
 * Retry counting is runtime state (attempts are append-only in the store and
 * the seam exposes no attempt read). A restart forgets counts; the DEC-21
 * recovery sweep (S1-c) re-drives effects-pending acceptances. Documented
 * v1 limitation, consistent with store-memory's no-durability stance (A4).
 *
 * Budget accounting (F12): the counter charges ACTUAL delivery attempts —
 * a decision round that contacts no live lane (presence-gone flap, zero
 * presences) is free; only a round that attempted and failed retryably
 * counts, and that count drives both backoff and exhaustion. Presence
 * flapping therefore cannot burn the budget without real retries. The
 * exhaustion attempt is recorded append-only EVEN when the exhaustion CAS
 * loses to a concurrent settle (same discipline as settleFailed), and the
 * runtime counter entry is dropped when the Delivery reaches a terminal
 * state (bounded map).
 */

import { schemaVersion } from "../contract/schemas.js";
import type {
  Cursor,
  Delivery,
  DeliveryAttempt,
  DeliveryState,
  Message,
  PersonId,
  Presence,
  TransportKind,
} from "../contract/schemas.js";
import type { ClockIds } from "../contract/ports/clock.js";
import type { MessagingStore } from "../contract/ports/store.js";
import type {
  EffectReport,
  PresenceTransport,
  RetryPolicy,
  Scheduler,
} from "../contract/ports/presence-transport.js";
import type { PresenceRegistry } from "./presenceRegistry.js";
import { storeDependencyError } from "./storeErrors.js";

export type { RetryPolicy, Scheduler } from "../contract/ports/presence-transport.js";

export interface DeliveryOrchestratorDeps {
  store: MessagingStore;
  clock: ClockIds;
  registry: PresenceRegistry;
  transports: ReadonlyMap<TransportKind, PresenceTransport>;
  retryPolicy: RetryPolicy;
  scheduler: Scheduler;
}

export interface DeliveryOrchestrator {
  /**
   * Acceptance decision point: run the first attempt decision per Delivery.
   * Blocked room recipients (R4) need NOTHING here — they committed terminal
   * failed{blocked-by-contact-policy} inside commitAcceptance (Store-Seam
   * §11.7), so attemptDecision's current-state re-read skips them like every
   * other terminal Delivery.
   */
  onAcceptance(
    message: Message,
    deliveries: Delivery[],
    urgentDowngraded: boolean,
  ): Promise<void>;
  /** Presence-open re-trigger: attempt decisions for the person's pending Deliveries. */
  onPresenceOpened(personId: PersonId): Promise<void>;
  /** DND release: held → pending (dnd-released) for the person, then attempts resume. */
  onDndReleased(personId: PersonId): Promise<void>;
}

export function createDeliveryOrchestrator(deps: DeliveryOrchestratorDeps): DeliveryOrchestrator {
  const { store, clock, registry, transports, retryPolicy, scheduler } = deps;
  /** Runtime retry counters (see header note — F12: actual attempts only). */
  const attemptsUsed = new Map<string, number>();
  /** L7: cancellation for scheduled retries — cleared on terminal settle. */
  const scheduledRetries = new Map<string, () => void>();

  /** Terminal-settle bookkeeping (F12/L7): counter entry dropped, parked retry cancelled. */
  function settledTerminally(deliveryId: Delivery["id"]): void {
    attemptsUsed.delete(deliveryId);
    const cancel = scheduledRetries.get(deliveryId);
    if (cancel !== undefined) {
      scheduledRetries.delete(deliveryId);
      cancel();
    }
  }

  function makeAttempt(
    deliveryId: Delivery["id"],
    presence: Presence,
    outcome: DeliveryAttempt["outcome"],
    detail?: string,
  ): DeliveryAttempt {
    return {
      id: clock.newId("attempt"),
      kind: "delivery-attempt",
      schemaVersion,
      createdAt: clock.now(),
      deliveryId,
      presenceId: presence.id,
      transport: presence.transport,
      outcome,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  /** Current state of a Delivery, re-read from the store (StateConflict re-decide). */
  async function currentState(delivery: Delivery): Promise<DeliveryState | undefined> {
    const found = await store.getDeliveries(delivery.messageId);
    if (found.kind === "error") return undefined;
    return found.value.find((candidate) => candidate.id === delivery.id)?.state;
  }

  /**
   * Settle delivered on a real adapter effect (DEC-08). The fan-out race
   * resolves at the store CAS: first effect wins; late effects and races with
   * a hold are re-decided against CURRENT state (R5).
   *
   * L1: a non-StateConflict store failure is THROWN (storeDependencyError) —
   * the acceptance path propagates it so effectsPending stays true and the
   * DEC-21 sweep re-drives; swallowed, it would strand a pending Delivery
   * with effects marked settled. And when the re-decision budget runs out,
   * the attempt is still recorded (superseded) — never silently dropped.
   */
  async function settleDelivered(delivery: Delivery, attempt: DeliveryAttempt): Promise<void> {
    let expected: DeliveryState = "pending";
    for (let redecisions = 0; redecisions < 3; redecisions += 1) {
      const result = await store.transitionDelivery(
        delivery.id,
        expected,
        "delivered",
        "adapter-effect",
        attempt,
      );
      if (result.kind === "ok") {
        settledTerminally(delivery.id);
        return;
      }
      if (result.error.name !== "StateConflict") {
        throw storeDependencyError(result.error); // L1 — see header
      }
      const actual = await currentState(delivery);
      if (actual === undefined) return; // record unreadable — the sweep re-drives
      if (actual === "held") {
        // in-flight-effect (R5): the effect genuinely occurred and cannot be
        // un-rung — held → delivered with reason adapter-effect.
        expected = "held";
        continue;
      }
      // delivered (fan-out loser) or failed: record the attempt as superseded
      // (DEC-16 auditability) and stop — the store's truth stands.
      await store.appendDeliveryAttempt(delivery.id, { ...attempt, outcome: "superseded" });
      settledTerminally(delivery.id);
      return;
    }
    // L1: the re-decision budget ran out against a still-moving state — the
    // attempt is recorded (superseded), never silently dropped.
    await store.appendDeliveryAttempt(delivery.id, { ...attempt, outcome: "superseded" });
  }

  /** pending → failed through the CAS, with the attempt recorded in the same write. */
  async function settleFailed(
    delivery: Delivery,
    reason: "retry-exhausted" | "transport-failure",
    attempt: DeliveryAttempt,
  ): Promise<void> {
    const result = await store.transitionDelivery(delivery.id, "pending", "failed", reason, attempt);
    if (result.kind === "error") {
      if (result.error.name === "StateConflict") {
        // Raced with a settle/hold — the CAS winner's state stands; keep the
        // attempt append-only so the race stays auditable (F12: the exhaustion
        // attempt is recorded even when the CAS loses).
        await store.appendDeliveryAttempt(delivery.id, attempt);
        settledTerminally(delivery.id);
      }
      // A store failure (non-conflict) leaves the Delivery pending AND the
      // counter/retry state intact — the sweep re-drives.
      return;
    }
    settledTerminally(delivery.id);
  }

  /** One addressed-lane attempt against one Presence (Seams §4.1 deliver). */
  async function attemptPresence(
    delivery: Delivery,
    message: Message,
    presence: Presence,
  ): Promise<"effect" | "retryable" | "permanent" | "presence-gone"> {
    const transport = transports.get(presence.transport);
    if (!transport) return "presence-gone"; // unregistered transport: treat the lane as dead
    let report: EffectReport;
    try {
      report = await transport.deliver(presence.id, { message, priority: message.priority });
    } catch (cause) {
      // Adapters return typed reports; a throw is an adapter bug — treat it as
      // a transient failure so it never escapes as an exception (Seams §4.2).
      report = {
        kind: "failure",
        retryable: true,
        detail: `adapter threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    if (report.kind === "effect") {
      await settleDelivered(delivery, makeAttempt(delivery.id, presence, "effect"));
      return "effect";
    }
    if (report.permanent === "presence-gone") {
      // Connection died mid-effect (§4.1): record, close via the SINGLE close
      // path (R9), Delivery stays pending (R5 no-presence rule).
      await store.appendDeliveryAttempt(
        delivery.id,
        makeAttempt(delivery.id, presence, "failure", report.detail),
      );
      await registry.closePath(presence.id);
      return "presence-gone";
    }
    if (!report.retryable) {
      await settleFailed(
        delivery,
        "transport-failure",
        makeAttempt(delivery.id, presence, "failure", report.detail),
      );
      return "permanent";
    }
    await store.appendDeliveryAttempt(
      delivery.id,
      makeAttempt(delivery.id, presence, "failure", report.detail),
    );
    return "retryable";
  }

  /**
   * THE attempt decision (R5 policyEvaluation): re-reads CURRENT DND policy,
   * then presence, then fans out. Called at acceptance, presence-open
   * re-trigger, and each retry wake.
   */
  async function attemptDecision(
    delivery: Delivery,
    message: Message,
    urgentDowngraded: boolean,
  ): Promise<void> {
    // Only pending Deliveries get decisions; held exits only via dnd-released
    // or in-flight-effect, and terminal states never move (R5).
    const state = await currentState(delivery);
    if (state !== "pending") return;

    // DND re-evaluation against CURRENT policy (never the acceptance value).
    const policies = await store.getPolicy(delivery.recipientId);
    if (policies.kind === "error" && policies.error.name !== "RecordNotFound") {
      throw storeDependencyError(policies.error);
    }
    const dndEnabled = policies.kind === "ok" ? (policies.value.dnd?.enabled ?? false) : false;
    const effectiveUrgent = message.priority === "urgent" && !urgentDowngraded;
    if (dndEnabled && !effectiveUrgent) {
      // pending → held (dnd-active). CAS: a concurrent settle wins and we stop.
      await store.transitionDelivery(delivery.id, "pending", "held", "dnd-hold");
      return;
    }

    const presences = registry.presencesFor(delivery.recipientId);
    if (presences.length === 0) return; // no-presence rule: pending, never failed

    // DEC-16 fan-out: attempt ALL live Presences; first real effect wins at
    // the store CAS; losers are recorded as superseded attempts.
    const outcomes = await Promise.all(
      presences.map((presence) => attemptPresence(delivery, message, presence)),
    );
    if (outcomes.includes("effect") || outcomes.includes("permanent")) return;
    if (outcomes.includes("retryable")) {
      // F12: the budget charges ACTUAL attempts — this round contacted a
      // lane and failed retryably, so it counts. Rounds that found no live
      // lane (presence-gone flap, zero presences) never reach here and stay
      // free: presence flapping cannot burn the budget without real retries.
      const used = (attemptsUsed.get(delivery.id) ?? 0) + 1;
      attemptsUsed.set(delivery.id, used);
      if (used >= retryPolicy.maxAttempts) {
        // settleFailed records the exhaustion attempt append-only even when
        // the CAS loses to a concurrent settle (F12).
        await settleFailed(
          delivery,
          "retry-exhausted",
          makeAttempt(delivery.id, presences[0] as Presence, "failure", "retry budget exhausted"),
        );
        return;
      }
      const delay = Math.min(
        retryPolicy.baseDelayMs * 2 ** (used - 1),
        retryPolicy.maxDelayMs,
      );
      const deliveryId = delivery.id;
      const cancel = scheduler.schedule(delay, () => {
        scheduledRetries.delete(deliveryId);
        void attemptDecision(delivery, message, urgentDowngraded).catch(() => {
          // A store failure inside a scheduled retry leaves the Delivery
          // pending; the DEC-21 sweep (S1-c) re-drives it. Never throw.
        });
      });
      // L7: a pending retry is cancellable — terminal settle clears it.
      scheduledRetries.set(deliveryId, cancel);
    }
    // else: every lane reported presence-gone → pending stands (no-presence),
    // and NO budget was consumed (F12).
  }

  /** The person's non-terminal Deliveries, via seam reads only (inbox = non-terminal, §11.2). */
  async function liveDeliveriesFor(
    personId: PersonId,
    state: "pending" | "held",
  ): Promise<{ delivery: Delivery; message: Message }[]> {
    const out: { delivery: Delivery; message: Message }[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await store.getInbox(
        personId,
        cursor !== undefined ? { cursor } : {},
      );
      if (page.kind === "error") {
        if (page.error.name === "RecordNotFound") return out;
        throw storeDependencyError(page.error);
      }
      for (const message of page.value.messages) {
        const deliveries = await store.getDeliveries(message.id);
        if (deliveries.kind === "error") continue;
        for (const delivery of deliveries.value) {
          if (delivery.recipientId === personId && delivery.state === state) {
            out.push({ delivery, message });
          }
        }
      }
      cursor = page.value.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  /** urgentDowngraded is persisted on the AcceptanceRecord (§11.3) — the honest source at re-trigger time. */
  async function wasDowngraded(message: Message): Promise<boolean> {
    const acceptance = await store.findAcceptance(message.senderId, message.clientMessageId);
    if (acceptance.kind === "error") return false;
    return acceptance.value.urgentDowngraded ?? false;
  }

  return {
    async onAcceptance(message, deliveries, urgentDowngraded): Promise<void> {
      // THE authoritative effect leg (send pipeline + DEC-21 sweep): a store
      // failure inside a settle PROPAGATES (L1) so the caller leaves
      // effectsPending true and the sweep re-drives — never a pending
      // Delivery with effects marked settled. Blocked room recipients (R4)
      // are already terminal failed from the commit (Store-Seam §11.7) —
      // attemptDecision's current-state re-read skips them.
      for (const delivery of deliveries) {
        await attemptDecision(delivery, message, urgentDowngraded);
      }
    },

    async onPresenceOpened(personId): Promise<void> {
      // Advisory re-trigger (R5 no-presence rule): a store failure here is
      // swallowed per delivery — the acceptance path owns effects-settled
      // honesty (L1), and a throw would surface inside an unrelated
      // OpenPresence command via the registry's opened-listeners.
      const pending = await liveDeliveriesFor(personId, "pending");
      for (const { delivery, message } of pending) {
        await attemptDecision(delivery, message, await wasDowngraded(message)).catch(() => {});
      }
    },

    async onDndReleased(personId): Promise<void> {
      const held = await liveDeliveriesFor(personId, "held");
      for (const { delivery, message } of held) {
        const released = await store.transitionDelivery(
          delivery.id,
          "held",
          "pending",
          "dnd-released",
        );
        if (released.kind === "ok") {
          await attemptDecision(delivery, message, await wasDowngraded(message)).catch(() => {
            // As onPresenceOpened: advisory path; the sweep re-drives.
          });
        }
        // StateConflict: an in-flight effect settled it — the CAS winner stands.
      }
    },
  };
}

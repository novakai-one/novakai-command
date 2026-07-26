/**
 * core/subscriptions — the Subscribe stream operation (R1), the MSG-023
 * anti-polling mechanism. A connected principal is PUSHED TO; polling exists
 * only as the reconnect-catch-up path.
 *
 * Design notes (frozen-contract faithful):
 *  - Committed-fact events arrive from core/eventBus (journal-sourced —
 *    emit-only-after-durable by construction). PresenceChanged arrives from
 *    the presence registry directly as an OBSERVATION (R11: no sequence, not
 *    journaled, never replayed, distinguishable by the absent `sequence` on
 *    the frame). On (re)subscribe, current presence state is sent as fresh
 *    observations (R1).
 *  - R3 per-subscriber payload filtering lives HERE (documented choice — the
 *    manager owns the subscriber's Principal snapshot and the store/membership
 *    reads the rule needs): MessageCommitted / DeliveryUpdated only for
 *    threads the subscriber may read — direct-pair member, or CURRENT room
 *    member per the membership seam (S2: isMember at fact time; a membership
 *    outage or unknown room filters the fact out — no push, no leak — and
 *    replay-after-reconnect is the recovery, R1); PolicyChanged only to the
 *    policy owner + policy.admin holders; PresenceChanged to all
 *    authenticated subscribers. Authorization is decided against the
 *    Principal snapshot taken AT SUBSCRIBE TIME (§2.1: a mid-session grant
 *    change takes effect at revalidate; subscriptions already flowing keep
 *    their decided authorization) combined with LIVE membership (R3's
 *    "current member" — a member removed from a room stops receiving its
 *    facts without re-subscribing).
 *  - Replay-after-disconnect: `since` cursor → committed-fact events with
 *    sequence > cursor replayed in order from the journal (scanJournal),
 *    then live. The subscription is registered BEFORE the replay scan and
 *    holds live facts arriving during it; a sequence watermark dedupes the
 *    replay/live seam — in-order, no gap, no overlap WITHIN a subscription.
 *    Across reconnects the policy stays at-least-once (R1): the consumer
 *    dedupes by sequence; exactly-once is never promised.
 *  - Fact offers are SERIALIZED per subscription (F6): every offer — live,
 *    held-merge, observation — runs on a per-subscription promise chain, so
 *    the watermark check-then-set (which spans the store IO in factPasses)
 *    is indivisible. Interleaved offers cannot reorder frames or regress the
 *    watermark.
 *  - started is ALWAYS the first frame (R1 lifecycle, F7): it is flushed
 *    before the replay begins, and if a subscription ends before started
 *    was delivered (e.g. replay overflow on a stalled lane) the ended path
 *    delivers started first, then ended — a client never sees ended as the
 *    first frame on a live lane.
 *  - Room-Thread authorization (S2 — REVISES the S1 L10 ruling): the S1
 *    build silently dropped room facts from unscoped streams because the
 *    membership seam did not exist. With the seam wired, that starvation is
 *    gone: room facts flow to CURRENT members (isMember at fact time), an
 *    EXPLICIT scope naming a room Thread the subscriber may not read fails
 *    the whole Subscribe with NotAuthorized (loud, G6 — unchanged), and an
 *    unscoped stream filters to readable threads with real membership. A
 *    membership-UNAVAILABLE resolution on the implicit path filters the fact
 *    (never a silent allow) but does not end the subscription — the durable
 *    recovery is replay on re-subscribe; on the EXPLICIT-scope path it fails
 *    the Subscribe with DependencyUnavailable{membership} (loud, §3.3).
 *  - Backpressure: each subscription has a bounded buffer (default
 *    constants.subscriptionBufferMax; composition may tighten — e.g. tests).
 *    A push-lane transient failure parks the head frame for retry (push lane
 *    has no R5 budget, R2); a buffer that fills ENDS the subscription
 *    (ended{overflow}) — the core never blocks on a slow subscriber.
 *    Permanent push failure ends the subscription too (a dead pusher must
 *    not pretend liveness, Seams §4.2); committed-fact recovery is the
 *    client re-subscribing with its last cursor.
 *  - Teardown (Seams §4.1): a Presence close ends every subscription bound
 *    to it — the manager hooks the registry's onChanged (the S1-b teardown
 *    seam). ended{closed} is sent best-effort: on a dead connection it is
 *    undeliverable, and that is fine — the durable recovery path is replay.
 *  - ended reasons (contract enum): overflow (buffer bound), closed
 *    (transport disconnect / client unsubscribe / permanent push failure),
 *    auth-lost (session invalidated, §2.1), dependency-lost (journal/store
 *    failure mid-stream, via the bus's error listener).
 *
 * The output lane is an injected SINK so both integration modes share ALL of
 * this logic (no per-mode business logic): standalone binds the sink to
 * `transport.push(presenceId, frame)`; embedded hosts pass a callback.
 */

import { constants } from "../public/contract/index.js";
import { MessagingError } from "../public/contract/index.js";
import type {
  Cursor,
  Presence,
  PresenceChangedEvent,
  PresenceId,
  Sequence,
  SubscribeInput,
  SubscribeInputEvents,
  SubscriptionEndedReason,
  SubscriptionId,
  SubscriptionMessage,
  Thread,
  ThreadId,
} from "../public/contract/index.js";
import type { Principal } from "../seams/authority.js";
import type { MembershipSource } from "../seams/membership.js";
import type { MessagingStore } from "../seams/store.js";
import type { ClockIds } from "../seams/clock.js";
import type { EffectReport, Scheduler } from "../seams/presenceTransport.js";
import type { CommittedFact, EventBus } from "./eventBus.js";
import type { PresenceRegistry } from "./presenceRegistry.js";
import { storeDependencyError } from "./storeErrors.js";

/**
 * The push lane for one subscription, reporting Seams §4.2 push outcomes:
 * effect = frame sent (leaves the buffer); transient failure = frame parked
 * for retry; permanent failure = the lane is dead, the subscription ends.
 */
export type SubscriptionSink = (frame: SubscriptionMessage) => Promise<EffectReport>;

export interface SubscriptionHandle {
  readonly subscriptionId: SubscriptionId;
  /** Client-initiated end: the stream closes with ended{closed} (best-effort). */
  close(): Promise<void>;
}

/**
 * Teardown binding (Seams §4.1): ties a subscription to a Presence so the
 * single presence-close path ends it. The Presence must be live and owned by
 * the subscribing principal, else ValidationFailed.
 */
export interface SubscriptionBinding {
  presenceId?: PresenceId;
}

export interface SubscriptionManagerDeps {
  store: MessagingStore;
  clock: ClockIds;
  bus: EventBus;
  registry: PresenceRegistry;
  scheduler: Scheduler;
  membership: MembershipSource;
  /** Per-subscription buffer bound (default constants.subscriptionBufferMax, R1). */
  bufferMax?: number;
  /** Parked-frame retry cadence for transient push failures (default 250 ms). */
  pushRetryDelayMs?: number;
}

export interface SubscriptionManager {
  /**
   * Attach a subscription (R1). Throws typed errors (NotAuthorized /
   * DependencyUnavailable) — the door converts. `binding.presenceId` ties
   * the subscription to a Presence for the §4.1 teardown (standalone mode);
   * embedded sinks may leave it unbound.
   */
  subscribe(
    principal: Principal,
    input: SubscribeInput,
    sink: SubscriptionSink,
    binding?: SubscriptionBinding,
  ): Promise<SubscriptionHandle>;
  /** Seams §4.1 teardown: presence close ends its subscriptions (ended{closed}). */
  endForPresence(presenceId: PresenceId): Promise<void>;
  /** §2.1: session invalidated → every subscription of the session ends (ended{auth-lost}). */
  endForSession(sessionId: string): Promise<void>;
}

interface LiveSubscription {
  id: SubscriptionId;
  /** Principal snapshot at subscribe time (§2.1 — authorization decided at subscribe). */
  principal: Principal;
  sessionId: string;
  events: SubscribeInputEvents[];
  /** Explicit thread scope (R1); absent = all threads the subscriber may read. */
  threads?: ThreadId[];
  sink: SubscriptionSink;
  presenceId?: PresenceId;
  state: "replaying" | "live" | "ended";
  buffer: SubscriptionMessage[];
  /** Live facts arriving while state === "replaying" (merged at the watermark). */
  held: CommittedFact[];
  /** Observations arriving while state === "replaying" (L6 — flushed after the fresh snapshot). */
  heldObs: PresenceChangedEvent[];
  /** Highest sequence enqueued — replay/live seam dedupe (compare, never count). */
  watermark: Sequence;
  flushing: boolean;
  /** F6: the per-subscription serialization chain for fact/observation offers. */
  chain: Promise<void>;
  /** F7: the started frame, kept until delivered so end() can deliver it first. */
  startedFrame?: SubscriptionMessage;
  startedDelivered: boolean;
  /** L7: cancellation for a parked retry flush (cleared on end). */
  parkedCancel?: (() => void) | undefined;
}

function notAuthorized(detail: string): MessagingError {
  return new MessagingError("NotAuthorized", {
    message: detail,
    retryable: false,
    fields: {},
  });
}

/** Cursor codec inverse (Store-Seam §3: "s_<n>" wraps the sequence). The door already pattern-checked. */
export function sequenceFromCursor(cursor: Cursor): Sequence {
  return Number(cursor.slice(2)) as Sequence;
}

/**
 * R3 member rule (S2): direct-pair member, or CURRENT room member per the
 * membership seam — or, per A-R-N4-1, an oversight.read holder (direct lanes
 * only; rooms unchanged). On the implicit filtering path a membership outage
 * or an unknown room collapses to unreadable — no push, no leak (never a
 * silent allow); the explicit-scope path uses assertReadable instead, which
 * fails loudly with the typed outcome.
 */
export async function mayReadThread(
  membership: MembershipSource,
  principal: Principal,
  thread: Thread,
): Promise<boolean> {
  if (thread.threadKind === "direct" && thread.direct) {
    const [a, b] = thread.direct.pair;
    if (principal.personId === a || principal.personId === b) return true;
    return principal.grants.includes("oversight.read"); // A-R-N4-1
  }
  if (!thread.room) return false; // corrupt payload — no leak
  const outcome = await membership.isMember(thread.room, principal.personId);
  return outcome.kind === "known" && outcome.member;
}

/** The explicit-scope half of R3 (G6): unreadable scope names fail LOUDLY with the typed outcome. */
async function assertReadable(
  membership: MembershipSource,
  principal: Principal,
  thread: Thread,
): Promise<void> {
  if (thread.threadKind === "direct" && thread.direct) {
    const [a, b] = thread.direct.pair;
    if (principal.personId === a || principal.personId === b) return;
    if (principal.grants.includes("oversight.read")) return; // A-R-N4-1
    throw notAuthorized(
      `subscriber may not read Thread ${thread.id} (R3) — explicit scope fails the whole Subscribe`,
    );
  }
  if (!thread.room) {
    throw notAuthorized(`explicit Subscribe scope names an unreadable Thread: ${thread.id}`);
  }
  const outcome = await membership.isMember(thread.room, principal.personId);
  if (outcome.kind === "known") {
    if (outcome.member) return;
    throw notAuthorized(
      `subscriber may not read Thread ${thread.id} (R3) — explicit scope fails the whole Subscribe`,
    );
  }
  if (outcome.kind === "unknown") {
    // §3.3's shared mapping would be UnknownThread, but Subscribe's error
    // list has no UnknownThread: an unreadable scope name is NotAuthorized
    // (recorded ambiguity — same ruling as a nonexistent Thread below).
    throw notAuthorized(`explicit Subscribe scope names an unreadable Thread: ${thread.id}`);
  }
  throw outcome.error; // DependencyUnavailable{membership, retryable: true} — loud (G6)
}

export function createSubscriptionManager(deps: SubscriptionManagerDeps): SubscriptionManager {
  const { store, clock, bus, registry, scheduler, membership } = deps;
  const bufferMax = deps.bufferMax ?? constants.subscriptionBufferMax;
  const pushRetryDelayMs = deps.pushRetryDelayMs ?? 250;

  const byId = new Map<string, LiveSubscription>();
  const byPresence = new Map<string, Set<string>>();
  const bySession = new Map<string, Set<string>>();

  function index(map: Map<string, Set<string>>, key: string, id: string): void {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set();
      map.set(key, set);
    }
    set.add(id);
  }

  function deindex(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (set === undefined) return;
    set.delete(id);
    if (set.size === 0) map.delete(key);
  }

  // --- R3 payload filtering (documented home: this module) --------------------

  /** True when the fact passes this subscription's kind + scope + R3 filters. */
  async function factPasses(sub: LiveSubscription, fact: CommittedFact): Promise<boolean> {
    if (!sub.events.includes(fact.kind)) return false;
    if (fact.kind === "PolicyChanged") {
      // PolicyChanged (R3): the policy owner + policy.admin holders only.
      return (
        fact.event.personId === sub.principal.personId ||
        sub.principal.grants.includes("policy.admin")
      );
    }
    const threadId =
      fact.kind === "MessageCommitted" ? fact.event.message.threadId : fact.event.delivery.threadId;
    // Explicit scope: thread-scoped events are confined to the named set.
    if (sub.threads !== undefined && !sub.threads.includes(threadId)) return false;
    const found = await store.getThread(threadId);
    if (found.kind === "error") return false; // unreadable/gone — no push, no leak
    return mayReadThread(membership, sub.principal, found.value);
  }

  /** Narrowing-safe ended check (enqueue/end mutate state across function calls). */
  function isEnded(sub: LiveSubscription): boolean {
    return sub.state === "ended";
  }

  // --- buffer / flush (Seams §4.2 push-lane accounting) ------------------------

  async function end(sub: LiveSubscription, reason: SubscriptionEndedReason): Promise<void> {
    if (sub.state === "ended") return;
    sub.state = "ended";
    sub.buffer = [];
    sub.held = [];
    sub.heldObs = [];
    if (sub.parkedCancel !== undefined) {
      // L7: a parked retry must not survive the subscription it serves.
      sub.parkedCancel();
      sub.parkedCancel = undefined;
    }
    byId.delete(sub.id);
    if (sub.presenceId !== undefined) deindex(byPresence, sub.presenceId, sub.id);
    deindex(bySession, sub.sessionId, sub.id);
    // F7: started is ALWAYS the first frame (R1 lifecycle). If the
    // subscription ends before started was delivered (e.g. overflow during
    // replay on a stalled lane), deliver started first, then ended — a
    // client on a live lane never sees ended as the first frame.
    if (!sub.startedDelivered && sub.startedFrame !== undefined) {
      try {
        const startedReport = await sub.sink(sub.startedFrame);
        if (startedReport.kind === "effect") sub.startedDelivered = true;
      } catch {
        // Best-effort — the subscription is ending regardless.
      }
    }
    // Best-effort: on a dead lane the ended frame is undeliverable, and that
    // is fine (Seams §4.1) — replay after re-subscribe is the recovery path.
    const frame: SubscriptionMessage = { kind: "ended", subscriptionId: sub.id, reason };
    try {
      await sub.sink(frame);
    } catch {
      // Sink threw — the subscription is ending regardless.
    }
  }

  function enqueue(sub: LiveSubscription, frame: SubscriptionMessage): void {
    if (sub.state === "ended") return;
    if (sub.buffer.length >= bufferMax) {
      // R1 overflow behaviour: the bound is hit → END the subscription; the
      // core never blocks on a slow subscriber. ended{overflow} is sent
      // directly (the buffer is dropped) — best-effort.
      void end(sub, "overflow");
      return;
    }
    sub.buffer.push(frame);
  }

  async function flush(sub: LiveSubscription): Promise<void> {
    if (sub.flushing || sub.state === "ended") return;
    sub.flushing = true;
    try {
      while (sub.buffer.length > 0 && !isEnded(sub)) {
        const frame = sub.buffer[0] as SubscriptionMessage;
        let report: EffectReport;
        try {
          report = await sub.sink(frame);
        } catch (cause) {
          // A sink throw is treated as a transient push failure — it must
          // never escape as an exception (mirrors the orchestrator's adapter
          // discipline, Seams §4.2).
          report = {
            kind: "failure",
            retryable: true,
            detail: `sink threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          };
        }
        if (report.kind === "effect") {
          sub.buffer.shift(); // frame confirmed sent — leaves the buffer (§4.2)
          if (frame.kind === "started") sub.startedDelivered = true; // F7
          continue;
        }
        if (!report.retryable || report.permanent !== undefined) {
          // Permanent failure: the frame is dropped and the subscription ENDS
          // (a dead pusher must not pretend liveness). Recovery = re-subscribe
          // with the last cursor (R1).
          await end(sub, "closed");
          return;
        }
        // Transient: the frame stays parked at the head; retried on the
        // cadence. The buffer bound still applies — a permanently-slow lane
        // ends as overflow, never as a block (R1). The retry is cancellable
        // (L7): end() cancels it so no timer survives the subscription.
        sub.parkedCancel = scheduler.schedule(pushRetryDelayMs, () => {
          sub.parkedCancel = undefined;
          void flush(sub);
        });
        return;
      }
    } finally {
      sub.flushing = false;
    }
  }

  // --- live fact / observation intake -------------------------------------------

  /**
   * F6: every offer to a subscription runs on its per-subscription promise
   * chain. The watermark check-then-set spans store IO (factPasses), so an
   * unchained offer can interleave with another and reorder frames or
   * regress the watermark — the chain makes each offer indivisible.
   */
  function offerFact(sub: LiveSubscription, fact: CommittedFact): Promise<void> {
    const run = sub.chain.then(() => offerFactSerialized(sub, fact));
    sub.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function offerFactSerialized(sub: LiveSubscription, fact: CommittedFact): Promise<void> {
    if (sub.state === "ended") return;
    if (sub.state === "replaying") {
      sub.held.push(fact);
      return;
    }
    const sequence = fact.event.sequence;
    if (sequence <= sub.watermark) return; // replay/live seam dedupe
    if (!(await factPasses(sub, fact))) return;
    sub.watermark = sequence;
    enqueue(sub, {
      kind: "event",
      subscriptionId: sub.id,
      sequence,
      event: fact.event as unknown as Record<string, unknown>,
    });
    await flush(sub);
  }

  /** R11 observations: no sequence, no watermark, no replay — live only (held during replay, L6). */
  function offerPresenceObservation(
    sub: LiveSubscription,
    event: PresenceChangedEvent,
  ): Promise<void> {
    // Serialized with fact offers on the same chain (F6) so observations
    // cannot interleave with a fact offer's buffer/watermark stretch.
    const run = sub.chain.then(() => offerPresenceObservationSerialized(sub, event));
    sub.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function offerPresenceObservationSerialized(
    sub: LiveSubscription,
    event: PresenceChangedEvent,
  ): Promise<void> {
    if (sub.state === "ended" || !sub.events.includes("PresenceChanged")) return;
    if (sub.state === "replaying") {
      // L6: observations in the replay→live window are held, not dropped,
      // and flushed after the fresh-snapshot observations at attach.
      sub.heldObs.push(event);
      return;
    }
    enqueue(sub, {
      kind: "event",
      subscriptionId: sub.id,
      event: event as unknown as Record<string, unknown>,
    });
    await flush(sub);
  }

  const manager: SubscriptionManager = {
    async subscribe(principal, input, sink, binding): Promise<SubscriptionHandle> {
      // The teardown binding must name a LIVE Presence owned by this
      // principal — a subscription cannot piggyback on someone else's
      // connection (Seams §4.1 teardown integrity).
      if (binding?.presenceId !== undefined) {
        const bound = registry.lookup(binding.presenceId);
        if (bound === undefined || bound.personId !== principal.personId) {
          throw new MessagingError("ValidationFailed", {
            message: `validation failed: presence: binding names a Presence that is not live and owned by this principal`,
            retryable: false,
            fields: {
              issues: [
                {
                  path: "presence",
                  message: `Presence ${binding.presenceId} is not a live Presence of this principal`,
                },
              ],
            },
          });
        }
      }

      // R3/G6: an explicit scope naming an unreadable Thread fails the whole
      // Subscribe — scope is never silently dropped. (Subscribe's error list
      // has no UnknownThread: a nonexistent Thread is unreadable by
      // definition, so the failure is NotAuthorized — recorded ambiguity.)
      for (const threadId of input.threads ?? []) {
        const found = await store.getThread(threadId);
        if (found.kind === "error") {
          if (found.error.name === "RecordNotFound") {
            throw notAuthorized(`explicit Subscribe scope names an unreadable Thread: ${threadId}`);
          }
          throw storeDependencyError(found.error);
        }
        await assertReadable(membership, principal, found.value);
      }

      const sub: LiveSubscription = {
        id: clock.newId("subscription"),
        principal,
        sessionId: principal.sessionId,
        events: [...input.events],
        ...(input.threads !== undefined && input.threads.length > 0
          ? { threads: [...input.threads] }
          : {}),
        sink,
        ...(binding?.presenceId !== undefined ? { presenceId: binding.presenceId } : {}),
        state: "replaying",
        buffer: [],
        held: [],
        heldObs: [],
        watermark: 0 as Sequence,
        flushing: false,
        chain: Promise.resolve(),
        startedDelivered: false,
      };

      // Registered BEFORE the replay scan: live facts arriving during replay
      // are held and merged at the watermark — no gap, no overlap.
      byId.set(sub.id, sub);
      if (sub.presenceId !== undefined) index(byPresence, sub.presenceId, sub.id);
      index(bySession, sub.sessionId, sub.id);

      const sinceSequence =
        input.since !== undefined ? sequenceFromCursor(input.since) : (0 as Sequence);

      // started is ALWAYS the first frame (R1 lifecycle, F7): kept on the
      // subscription until delivered so end() can deliver it first even when
      // the subscription ends before any flush (e.g. replay overflow).
      sub.startedFrame = {
        kind: "started",
        subscriptionId: sub.id,
        ...(input.since !== undefined ? { replayedFrom: input.since } : {}),
      };
      enqueue(sub, sub.startedFrame);
      // F7: flush started BEFORE the replay begins — it crosses a live lane
      // before any replay event; a permanent lane failure ends the
      // subscription here (ended{closed}), never emitting anything else.
      await flush(sub);
      if (isEnded(sub)) {
        return { subscriptionId: sub.id, close: async () => end(sub, "closed") };
      }

      // Replay: committed-fact events with sequence > cursor, in journal
      // order. A store failure HERE is a subscribe-time DependencyUnavailable
      // (R1) — the subscription is torn down and the error thrown to the door.
      let replayCursor = sinceSequence;
      try {
        for (;;) {
          const page = await store.scanJournal(replayCursor, constants.pageLimitMax);
          if (page.kind === "error") throw storeDependencyError(page.error);
          for (const entry of page.value) {
            replayCursor = entry.sequence;
            if (entry.kind === "TemplateWritten") continue; // no public event (store seam note)
            const fact: CommittedFact =
              entry.kind === "MessageCommitted"
                ? { kind: "MessageCommitted", event: { sequence: entry.sequence, message: entry.message } }
                : entry.kind === "DeliveryUpdated"
                  ? { kind: "DeliveryUpdated", event: { sequence: entry.sequence, delivery: entry.delivery } }
                  : {
                      kind: "PolicyChanged",
                      event: {
                        sequence: entry.sequence,
                        personId: entry.personId,
                        policy: entry.policy,
                        revision: entry.revision,
                      },
                    };
            if (entry.sequence <= sub.watermark) continue;
            if (!(await factPasses(sub, fact))) continue;
            sub.watermark = entry.sequence;
            enqueue(sub, {
              kind: "event",
              subscriptionId: sub.id,
              sequence: entry.sequence,
              event: fact.event as unknown as Record<string, unknown>,
            });
            if (isEnded(sub)) break; // overflowed mid-replay
          }
          if (isEnded(sub) || page.value.length < constants.pageLimitMax) break;
        }
      } catch (error) {
        byId.delete(sub.id);
        if (sub.presenceId !== undefined) deindex(byPresence, sub.presenceId, sub.id);
        deindex(bySession, sub.sessionId, sub.id);
        throw error;
      }
      if (isEnded(sub)) {
        // Overflowed during replay — the subscription is already ended (the
        // ended{overflow} frame carries the truth); the handle just identifies it.
        return { subscriptionId: sub.id, close: async () => end(sub, "closed") };
      }

      // R1: on (re)subscribe, current presence state is sent as FRESH
      // observations (never replayed — observations have no history).
      if (sub.events.includes("PresenceChanged")) {
        for (const presence of registry.all()) {
          enqueue(sub, {
            kind: "event",
            subscriptionId: sub.id,
            event: { presence, change: "opened" } as unknown as Record<string, unknown>,
          });
          if (isEnded(sub)) break;
        }
      }

      sub.state = "live";
      // Merge held live facts at the watermark (F6: through the chain, so a
      // fact arriving DURING the merge queues behind it in order), then the
      // held observations (L6), then start pushing.
      const held = sub.held;
      sub.held = [];
      for (const fact of held) {
        await offerFact(sub, fact);
      }
      const heldObs = sub.heldObs;
      sub.heldObs = [];
      for (const observation of heldObs) {
        // Flushed after the fresh snapshot above; duplicates are possible
        // (observations are at-least-once, self-healing — R11).
        await offerPresenceObservation(sub, observation);
      }
      await flush(sub);

      return {
        subscriptionId: sub.id,
        close: async () => end(sub, "closed"),
      };
    },

    async endForPresence(presenceId: PresenceId): Promise<void> {
      const ids = byPresence.get(presenceId);
      if (ids === undefined) return;
      for (const id of [...ids]) {
        const sub = byId.get(id);
        if (sub !== undefined) await end(sub, "closed");
      }
    },

    async endForSession(sessionId: string): Promise<void> {
      const ids = bySession.get(sessionId);
      if (ids === undefined) return;
      for (const id of [...ids]) {
        const sub = byId.get(id);
        if (sub !== undefined) await end(sub, "auth-lost");
      }
    },
  };

  // The bus feeds committed facts; a journal failure mid-stream ends live
  // subscriptions with dependency-lost (R1 failure coverage, mid-stream half).
  bus.onFact(async (fact) => {
    for (const sub of [...byId.values()]) {
      await offerFact(sub, fact);
    }
  });
  bus.onError(() => {
    for (const sub of [...byId.values()]) {
      void end(sub, "dependency-lost");
    }
  });

  // The registry feeds observations AND the §4.1 teardown (single close path —
  // the hook S1-b's registry comment reserved for this layer).
  registry.onChanged(async (event) => {
    if (event.change === "closed") {
      await manager.endForPresence(event.presence.id);
    }
    for (const sub of [...byId.values()]) {
      await offerPresenceObservation(sub, event);
    }
  });

  return manager;
}

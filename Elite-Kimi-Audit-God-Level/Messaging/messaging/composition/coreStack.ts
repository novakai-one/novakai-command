/**
 * composition/coreStack — the ONE wiring of the Messaging core, shared by
 * every composition root (embedded.ts, standalone.ts). Extracted in S1-c so
 * the two integration modes can never drift: same registry hooks, same
 * orchestrator wiring, same event bus, same subscription manager, same
 * session doors (the "no per-mode business logic" law). Composition roots
 * differ ONLY in which adapters they choose and how external input arrives.
 *
 * Wiring (identical to S1-b's embedded root, plus the S1-c modules):
 *   clock → store → authority → transports → registry → orchestrator
 *   → eventBus (journal tail) → subscriptionManager (R1)
 *   → sendPipeline / policyCommands / presenceCommands / queries → sessions.
 *
 * Session wiring notes:
 *  - Every session gets the §2.1 onEnded hook → subscriptions.endForSession
 *    (revalidate-invalid terminates live subscriptions with ended{auth-lost}).
 *  - The bus is driven per mode: standalone passes busPollIntervalMs;
 *    embedded pumps explicitly (pumpEvents) for test determinism. Either way
 *    event CONTENT is journal-sourced (emit-only-after-durable).
 *  - The DEC-21 recovery sweep is exposed as runRecoverySweep(); the
 *    composition root decides when to run it (standalone: at startup, before
 *    accepting connections). With sweepIntervalMs set, the stack ALSO sweeps
 *    periodically on an unref'd timer (Store-Seam §7, F11) — one wiring,
 *    both roots.
 */

import type { CapabilityView } from "../public/contract/index.js";
import type {
  EmbeddedAuthOutcome,
  MessagingSession,
  Outcome,
} from "../public/capability.js";
import type { ClockIds } from "../seams/clock.js";
import type { MessagingStore } from "../seams/store.js";
import type { Authority, Principal, ProvisioningDirectory } from "../seams/authority.js";
import type { PresenceTransport } from "../seams/presenceTransport.js";
import { DEFAULT_RETRY_POLICY, systemScheduler } from "../seams/presenceTransport.js";
import type { RetryPolicy, Scheduler } from "../seams/presenceTransport.js";
import type { TransportKind } from "../public/contract/index.js";
import { createSystemClock } from "../adapters/clock-system.js";
import { createMemoryStore } from "../adapters/store-memory.js";
import { createConfigAuthority } from "../adapters/authority-config.js";
import type { AuthorityConfig } from "../adapters/authority-config.js";
import { createMemoryPresenceTransport } from "../adapters/presence-transport-memory.js";
import { createPresenceRegistry } from "../core/presenceRegistry.js";
import type { PresenceRegistry } from "../core/presenceRegistry.js";
import { createDeliveryOrchestrator } from "../core/deliveryOrchestrator.js";
import type { DeliveryOrchestrator } from "../core/deliveryOrchestrator.js";
import { createSendPipeline } from "../core/sendPipeline.js";
import { createPolicyCommands } from "../core/policyCommands.js";
import { createPresenceCommands } from "../core/presenceCommands.js";
import { capabilityView, createQueries } from "../core/queries.js";
import { createSession } from "../core/session.js";
import { createEventBus } from "../core/eventBus.js";
import type { EventBus } from "../core/eventBus.js";
import { createSubscriptionManager } from "../core/subscriptions.js";
import type { SubscriptionManager } from "../core/subscriptions.js";
import { runRecoverySweep } from "../core/recoverySweep.js";
import type { RecoverySweepReport } from "../core/recoverySweep.js";
import {
  parseClosePresenceInput,
  parseGetDeliveryInput,
  parseGetInboxInput,
  parseGetMessagesInput,
  parseGetPolicyInput,
  parseGetPresenceInput,
  parseGetThreadInput,
  parseOpenPresenceInput,
  parseSetContactPolicyInput,
  parseSetDndPolicyInput,
  parseSubscribeInput,
} from "../core/validate.js";
import type { ParseResult } from "../core/validate.js";

export interface CoreStackOptions {
  /** AuthorityConfig (the stack builds authority-config; DEC-07 role→grant mapping lives in that config, never core) OR a ready seam pair. */
  authority: AuthorityConfig | (Authority & ProvisioningDirectory);
  clock?: ClockIds;
  /** Defaults to store-memory (A4: test/harness only — production passes openJsonlStore). */
  store?: MessagingStore;
  /** Registered presence transports; defaults to one memory transport as "ws". */
  transports?: PresenceTransport[];
  retryPolicy?: RetryPolicy;
  scheduler?: Scheduler;
  /** §2.1 degraded grace period (v1 default 5 min). */
  revalidateGraceMs?: number;
  /** When set, the event bus tails the journal on this interval (standalone). */
  busPollIntervalMs?: number;
  /** Per-subscription buffer bound (default constants.subscriptionBufferMax, R1). */
  subscriptionBufferMax?: number;
  /** Parked-frame retry cadence for transient push failures (default 250 ms). */
  pushRetryDelayMs?: number;
  /**
   * DEC-21 periodic sweep interval (Store-Seam §7: the sweep runs on startup
   * AND periodically). Unref'd; cleared on close(). Absent = manual only
   * (runRecoverySweep) — embedded hosts that want the periodic sweep opt in;
   * the standalone root sets a default (F11).
   */
  sweepIntervalMs?: number;
  /** TEST-ONLY fault injection (F4): delay the commit→settle window in the send pipeline. */
  effectLegDelayMs?: number;
}

export interface CoreStack {
  readonly clock: ClockIds;
  readonly store: MessagingStore;
  readonly authority: Authority & ProvisioningDirectory;
  readonly transports: readonly PresenceTransport[];
  readonly transportMap: ReadonlyMap<TransportKind, PresenceTransport>;
  readonly registry: PresenceRegistry;
  readonly orchestrator: DeliveryOrchestrator;
  readonly bus: EventBus;
  readonly subscriptions: SubscriptionManager;

  /** Position the bus at the journal tail and begin interval tailing if configured. */
  start(): Promise<void>;
  /** One journal tail cycle NOW (embedded determinism / post-commit trigger). */
  pumpEvents(): Promise<void>;
  /** DEC-21: re-drive every effects-pending acceptance; idempotent. */
  runRecoverySweep(): Promise<RecoverySweepReport>;
  capabilities(protocolVersion: string): CapabilityView;
  authenticate(credential: unknown): Promise<EmbeddedAuthOutcome>;
  buildSession(principal: Principal): MessagingSession;
  close(): Promise<void>;
}

function isAuthorityAdapter(
  value: CoreStackOptions["authority"],
): value is Authority & ProvisioningDirectory {
  return typeof (value as Authority).authenticate === "function";
}

export function createCoreStack(options: CoreStackOptions): CoreStack {
  const clock = options.clock ?? createSystemClock();
  const store = options.store ?? createMemoryStore(clock);
  const authority: Authority & ProvisioningDirectory = isAuthorityAdapter(options.authority)
    ? options.authority
    : createConfigAuthority(options.authority, clock);
  const transports: readonly PresenceTransport[] =
    options.transports ?? [createMemoryPresenceTransport({ kind: "ws" })];
  const transportMap = new Map<TransportKind, PresenceTransport>(
    transports.map((transport) => [transport.kind, transport]),
  );

  const registry = createPresenceRegistry(clock);
  for (const transport of transports) {
    transport.attachLiveness(registry.liveness);
  }
  const orchestrator = createDeliveryOrchestrator({
    store,
    clock,
    registry,
    transports: transportMap,
    retryPolicy: options.retryPolicy ?? DEFAULT_RETRY_POLICY,
    scheduler: options.scheduler ?? systemScheduler,
  });
  // R5 no-presence rule: every PresenceChanged(opened) re-triggers attempt decisions.
  registry.onOpened((presence) => orchestrator.onPresenceOpened(presence.personId));

  const bus = createEventBus(store, {
    ...(options.busPollIntervalMs !== undefined
      ? { pollIntervalMs: options.busPollIntervalMs }
      : {}),
  });
  const subscriptions = createSubscriptionManager({
    store,
    clock,
    bus,
    registry,
    scheduler: options.scheduler ?? systemScheduler,
    ...(options.subscriptionBufferMax !== undefined
      ? { bufferMax: options.subscriptionBufferMax }
      : {}),
    ...(options.pushRetryDelayMs !== undefined
      ? { pushRetryDelayMs: options.pushRetryDelayMs }
      : {}),
  });

  const sendMessage = createSendPipeline({
    store,
    clock,
    provisioning: authority,
    orchestrator,
    ...(options.effectLegDelayMs !== undefined
      ? { effectLegDelayMs: options.effectLegDelayMs }
      : {}),
  });
  const policies = createPolicyCommands({ store, clock, orchestrator });
  const presence = createPresenceCommands({ registry, transports: transportMap });
  const queries = createQueries({ store, clock, registry });

  // F11 (DEC-21, Store-Seam §7): the sweep runs on startup (composition
  // roots call runRecoverySweep / accept-after-sweep) AND periodically. The
  // timer is unref'd (never holds the process) and cleared on close(); the
  // sweep is idempotent and safe with zero pending, so an interval fire
  // mid-operation is harmless. Tests drive runRecoverySweep manually.
  let sweepTimer: NodeJS.Timeout | undefined;
  if (options.sweepIntervalMs !== undefined && options.sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      void runRecoverySweep({ store, orchestrator }).catch(() => {
        // A failed sweep pass is retried at the next interval; the startup
        // sweep and manual runs surface their own reports.
      });
    }, options.sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function buildSession(principal: Principal): MessagingSession {
    const core = createSession(principal, {
      authority,
      clock,
      ...(options.revalidateGraceMs !== undefined ? { graceMs: options.revalidateGraceMs } : {}),
      // §2.1: an ended session terminates its live subscriptions (auth-lost).
      onEnded: () => {
        void subscriptions.endForSession(principal.sessionId);
      },
    });

    /** Parse at the door, then run the typed core operation (MSG-021). */
    function door<I, R>(
      parse: (input: unknown) => ParseResult<I>,
      operation: (principal: Principal, input: I) => Promise<R>,
    ): (input: unknown) => Promise<Outcome<R>> {
      return (input: unknown) =>
        core.run(async (principal) => {
          const parsed = parse(input);
          if (!parsed.ok) throw parsed.error;
          return operation(principal, parsed.value);
        });
    }

    return {
      get principal() {
        return core.principal;
      },
      get state() {
        return core.state;
      },
      revalidate: () => core.revalidate(),

      sendMessage: (input: unknown) =>
        core.run(async (principal) => {
          const outcome = await sendMessage(principal, input);
          if (outcome.kind === "rejected") throw outcome.error;
          return outcome.result;
        }),
      openPresence: door(parseOpenPresenceInput, presence.openPresence),
      closePresence: door(parseClosePresenceInput, presence.closePresence),
      setDndPolicy: door(parseSetDndPolicyInput, policies.setDndPolicy),
      setContactPolicy: door(parseSetContactPolicyInput, policies.setContactPolicy),

      getThread: door(parseGetThreadInput, queries.getThread),
      getMessages: door(parseGetMessagesInput, queries.getMessages),
      getInbox: door(parseGetInboxInput, queries.getInbox),
      getDelivery: door(parseGetDeliveryInput, queries.getDelivery),
      getPolicy: door(parseGetPolicyInput, queries.getPolicy),
      getPresence: door(parseGetPresenceInput, queries.getPresence),

      subscribe: (input: unknown, sink, binding) =>
        core.run(async (principal) => {
          const parsed = parseSubscribeInput(input);
          if (!parsed.ok) throw parsed.error;
          return subscriptions.subscribe(principal, parsed.value, sink, binding);
        }),
    };
  }

  return {
    clock,
    store,
    authority,
    transports,
    transportMap,
    registry,
    orchestrator,
    bus,
    subscriptions,

    async start(): Promise<void> {
      await bus.start();
    },

    async pumpEvents(): Promise<void> {
      await bus.pump();
    },

    runRecoverySweep(): Promise<RecoverySweepReport> {
      return runRecoverySweep({ store, orchestrator });
    },

    capabilities(protocolVersion: string): CapabilityView {
      // L4: capabilityView already carries the contract-source version.
      return capabilityView(protocolVersion);
    },

    async authenticate(credential: unknown): Promise<EmbeddedAuthOutcome> {
      const outcome = await authority.authenticate(credential);
      if (outcome.kind !== "authenticated") return outcome;
      return {
        kind: "authenticated",
        principal: outcome.principal,
        session: buildSession(outcome.principal),
      };
    },

    buildSession,

    async close(): Promise<void> {
      if (sweepTimer !== undefined) {
        clearInterval(sweepTimer);
        sweepTimer = undefined;
      }
      bus.stop();
      await store.close();
    },
  };
}

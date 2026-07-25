/**
 * composition/coreStack — the ONE wiring of the Messaging core, shared by
 * every composition root (embedded.ts, standalone.ts). Extracted in S1-c so
 * the two integration modes can never drift: same registry hooks, same
 * orchestrator wiring, same event bus, same subscription manager, same
 * session doors (the "no per-mode business logic" law). Composition roots
 * differ ONLY in which adapters they choose and how external input arrives.
 *
 * Wiring (identical to S1-b's embedded root, plus the S1-c/S2/S4 modules):
 *   clock → store → authority → membership → transports → registry → orchestrator
 *   → eventBus (journal tail) → subscriptionManager (R1)
 *   → sendPipeline / sendFromTemplatePipeline / policyCommands / templateCommands
 *   → presenceCommands / queries → sessions.
 *
 * S2 (rooms): the membership seam wires into the send pipeline (R8 fresh
 * resolution inside the accept call), the queries (R3 room read
 * authorization), and the subscription manager (room fact filtering). When
 * the membership option is a MembershipConfig, start() provisions each
 * declared room's Thread via the store's createRoomThread (Store-Seam
 * §11.4) before the bus starts — the get-or-create makes restarts
 * idempotent, and a provisioning failure fails start loudly (G6).
 *
 * Session wiring notes:
 *  - Every session gets the §2.1 onEnded hook → subscriptions.endForSession
 *    (revalidate-invalid terminates live subscriptions with ended{auth-lost}).
 *  - The bus is driven per mode: standalone passes busPollIntervalMs;
 *    embedded pumps explicitly (pumpEvents) for test determinism. Either way
 *    event CONTENT is journal-sourced (emit-only-after-durable).
 *  - The DEC-21 recovery sweep is exposed as runRecoverySweep(); both
 *    composition roots sweep at startup (standalone: before accepting
 *    connections; embedded: inside start(), F10). With sweepIntervalMs set,
 *    the stack ALSO sweeps periodically on an unref'd timer (Store-Seam §7,
 *    F11) — one wiring, both roots.
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
import { createConfigMembership } from "../adapters/membership-config.js";
import type { MembershipConfig } from "../adapters/membership-config.js";
import type { MembershipSource } from "../seams/membership.js";
import { DEFAULT_MEMBERSHIP_DEADLINE_MS, withMembershipDeadline } from "../seams/membership.js";
import { createMemoryPresenceTransport } from "../adapters/presence-transport-memory.js";
import { createPresenceRegistry } from "../core/presenceRegistry.js";
import type { PresenceRegistry } from "../core/presenceRegistry.js";
import { createDeliveryOrchestrator } from "../core/deliveryOrchestrator.js";
import type { DeliveryOrchestrator } from "../core/deliveryOrchestrator.js";
import { createSendFromTemplatePipeline, createSendPipeline } from "../core/sendPipeline.js";
import { createPolicyCommands } from "../core/policyCommands.js";
import { createPresenceCommands } from "../core/presenceCommands.js";
import { createTemplateCommands } from "../core/templates.js";
import { capabilityView, createQueries } from "../core/queries.js";
import { createSession } from "../core/session.js";
import { createEventBus } from "../core/eventBus.js";
import type { EventBus } from "../core/eventBus.js";
import { createSubscriptionManager } from "../core/subscriptions.js";
import type { SubscriptionManager } from "../core/subscriptions.js";
import { runRecoverySweep } from "../core/recoverySweep.js";
import type { RecoverySweepReport } from "../core/recoverySweep.js";
import { storeDependencyError } from "../core/storeErrors.js";
import {
  parseClosePresenceInput,
  parseGetDeliveryInput,
  parseGetInboxInput,
  parseGetMessagesInput,
  parseGetPolicyInput,
  parseGetPresenceInput,
  parseGetThreadInput,
  parseListTemplatesInput,
  parseListThreadsForPersonInput,
  parseOpenPresenceInput,
  parseRetireTemplateInput,
  parseSetContactPolicyInput,
  parseSetDndPolicyInput,
  parseSubscribeInput,
  parseUpsertTemplateInput,
} from "../core/validate.js";
import type { ParseResult } from "../core/validate.js";

export interface CoreStackOptions {
  /** AuthorityConfig (the stack builds authority-config; DEC-07 role→grant mapping lives in that config, never core) OR a ready seam pair. */
  authority: AuthorityConfig | (Authority & ProvisioningDirectory);
  /**
   * MembershipConfig (the stack builds membership-config; the room/roster
   * truth lives in that config, never core — Seams §3) OR a ready
   * MembershipSource. Default: an empty config (no rooms — S1 behaviour).
   * When a MembershipConfig is passed, start() ALSO provisions each declared
   * room's Thread via the store's createRoomThread (Store-Seam §11.4 — the
   * get-or-create makes restarts idempotent). A ready MembershipSource gets
   * NO provisioning: the host owns room Thread creation.
   */
  membership?: MembershipConfig | MembershipSource;
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
  /**
   * Seams §3.3: the bounded per-call deadline on the membership seam,
   * enforced HERE in ONE place (the withMembershipDeadline wrapper) so both
   * composition roots and every caller get it. Default 3 s; tests may
   * tighten it. A breach → DependencyUnavailable{membership, retryable:true}.
   */
  membershipDeadlineMs?: number;
}

export interface CoreStack {
  readonly clock: ClockIds;
  readonly store: MessagingStore;
  readonly authority: Authority & ProvisioningDirectory;
  /**
   * The RAW membership adapter handle (composition-owned — adapter-private
   * controls like setUnavailable/configuredRooms live here). The CORE
   * consumes this source through the §3.3 deadline wrapper (F8) wired
   * internally; the wrapper enforces the bounded deadline on every
   * core-facing call.
   */
  readonly membership: MembershipSource;
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

function isMembershipSource(
  value: NonNullable<CoreStackOptions["membership"]>,
): value is MembershipSource {
  return typeof (value as MembershipSource).resolveMembers === "function";
}

export function createCoreStack(options: CoreStackOptions): CoreStack {
  const clock = options.clock ?? createSystemClock();
  const store = options.store ?? createMemoryStore(clock);
  const authority: Authority & ProvisioningDirectory = isAuthorityAdapter(options.authority)
    ? options.authority
    : createConfigAuthority(options.authority, clock);
  const membershipOption = options.membership ?? { rooms: [] };
  const rawMembership: MembershipSource = isMembershipSource(membershipOption)
    ? membershipOption
    : createConfigMembership(membershipOption, clock);
  // Seams §3.3 (F8): the bounded per-call deadline is enforced HERE, in the
  // ONE wiring — no adapter can hang a caller, and every consumer of the seam
  // (send path, R3 reads, subscriptions) gets the same guarantee. The stack
  // HANDLE exposes the raw adapter (adapter-private controls); the core
  // consumes ONLY this wrapped source.
  const membership: MembershipSource = withMembershipDeadline(
    rawMembership,
    options.membershipDeadlineMs ?? DEFAULT_MEMBERSHIP_DEADLINE_MS,
  );
  // Store-Seam §11.4 provisioning source: only a MembershipConfig reveals its
  // rooms to the root; a ready MembershipSource leaves creation to the host.
  const roomsToProvision: MembershipConfig["rooms"] = isMembershipSource(membershipOption)
    ? []
    : membershipOption.rooms;
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
    membership,
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
    membership,
    orchestrator,
    ...(options.effectLegDelayMs !== undefined
      ? { effectLegDelayMs: options.effectLegDelayMs }
      : {}),
  });
  const sendFromTemplate = createSendFromTemplatePipeline({
    store,
    clock,
    provisioning: authority,
    membership,
    orchestrator,
    ...(options.effectLegDelayMs !== undefined
      ? { effectLegDelayMs: options.effectLegDelayMs }
      : {}),
  });
  const policies = createPolicyCommands({ store, clock, orchestrator });
  const templateCommands = createTemplateCommands({ store, clock });
  const presence = createPresenceCommands({ registry, transports: transportMap });
  const queries = createQueries({ store, clock, registry, membership });

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
      sendFromTemplate: (input: unknown) =>
        core.run(async (principal) => {
          const outcome = await sendFromTemplate(principal, input);
          if (outcome.kind === "rejected") throw outcome.error;
          return outcome.result;
        }),
      openPresence: door(parseOpenPresenceInput, presence.openPresence),
      closePresence: door(parseClosePresenceInput, presence.closePresence),
      setDndPolicy: door(parseSetDndPolicyInput, policies.setDndPolicy),
      setContactPolicy: door(parseSetContactPolicyInput, policies.setContactPolicy),
      upsertTemplate: door(parseUpsertTemplateInput, templateCommands.upsertTemplate),
      retireTemplate: door(parseRetireTemplateInput, templateCommands.retireTemplate),

      getThread: door(parseGetThreadInput, queries.getThread),
      listThreadsForPerson: door(parseListThreadsForPersonInput, queries.listThreadsForPerson),
      getMessages: door(parseGetMessagesInput, queries.getMessages),
      getInbox: door(parseGetInboxInput, queries.getInbox),
      getDelivery: door(parseGetDeliveryInput, queries.getDelivery),
      getPolicy: door(parseGetPolicyInput, queries.getPolicy),
      listTemplates: door(parseListTemplatesInput, queries.listTemplates),
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
    membership: rawMembership, // the handle exposes the raw adapter; the core uses the §3.3-wrapped source (F8)
    transports,
    transportMap,
    registry,
    orchestrator,
    bus,
    subscriptions,

    async start(): Promise<void> {
      // Store-Seam §11.4: provision each configured room's Thread BEFORE
      // serving (get-or-create by room key — restart-idempotent). A
      // provisioning failure fails start loudly (G6; never serve a
      // half-provisioned capability).
      for (const room of roomsToProvision) {
        const created = await store.createRoomThread({
          threadKind: room.threadKind,
          authority: room.authority,
          externalId: room.externalId,
        });
        if (created.kind === "error") {
          throw storeDependencyError(created.error);
        }
      }
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

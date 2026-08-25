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

import type { CapabilityView, TransportKind } from "../schemas.js";
import type { EmbeddedAuthOutcome, MessagingSession } from "../api.js";
import type { Authority, Principal, ProvisioningDirectory } from "../ports/authority.js";
import type { PresenceTransport } from "../ports/presence-transport.js";
import { DEFAULT_RETRY_POLICY, systemScheduler } from "../ports/presence-transport.js";
import { createSystemClock } from "../../adapters/clock-system.js";
import { createMemoryStore } from "../../adapters/store-memory.js";
import { createConfigAuthority } from "../../adapters/authority-config.js";
import { createConfigMembership } from "../../adapters/membership-config.js";
import type { MembershipConfig } from "../../adapters/membership-config.js";
import type { MembershipSource } from "../ports/membership.js";
import { DEFAULT_MEMBERSHIP_DEADLINE_MS, withMembershipDeadline } from "../ports/membership.js";
import { createMemoryPresenceTransport } from "../../adapters/presence-transport-memory.js";
import { createPresenceRegistry } from "../../core/presenceRegistry.js";
import { createDeliveryOrchestrator } from "../../core/deliveryOrchestrator.js";
import { createSendFromTemplatePipeline, createSendPipeline } from "../../core/sendPipeline.js";
import { createPolicyCommands } from "../../core/policyCommands.js";
import { createPresenceCommands } from "../../core/presenceCommands.js";
import { createTemplateCommands } from "../../core/templates.js";
import { capabilityView, createQueries } from "../../core/queries.js";
import { createEventBus } from "../../core/eventBus.js";
import { createSubscriptionManager } from "../../core/subscriptions.js";
import { runRecoverySweep } from "../../core/recoverySweep.js";
import type { RecoverySweepReport } from "../../core/recoverySweep.js";
import { storeDependencyError } from "../../core/storeErrors.js";
import { createStackSession } from "./stack-support.js";
import type { CoreStack, CoreStackOptions } from "./stack-support.js";
export type { CoreStack, CoreStackOptions } from "./stack-support.js";

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
    return createStackSession({
      principal,
      authority,
      clock,
      subscriptions,
      sendMessage,
      sendFromTemplate,
      policies,
      presence,
      templates: templateCommands,
      queries,
      ...(options.revalidateGraceMs !== undefined
        ? { revalidateGraceMs: options.revalidateGraceMs }
        : {}),
    });
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

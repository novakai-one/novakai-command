/** Public stack declarations and authenticated-session assembly. */

import type { CapabilityView, TransportKind } from "../schemas.js";
import type { EmbeddedAuthOutcome, MessagingSession, Outcome } from "../api.js";
import type { ClockIds } from "../ports/clock.js";
import type { MessagingStore } from "../ports/store.js";
import type { Authority, Principal, ProvisioningDirectory } from "../ports/authority.js";
import type { MembershipSource } from "../ports/membership.js";
import type { PresenceTransport, RetryPolicy, Scheduler } from "../ports/presence-transport.js";
import type { AuthorityConfig } from "../../adapters/authority-config.js";
import type { MembershipConfig } from "../../adapters/membership-config.js";
import type { PresenceRegistry } from "../../core/presenceRegistry.js";
import type { DeliveryOrchestrator } from "../../core/deliveryOrchestrator.js";
import type { EventBus } from "../../core/eventBus.js";
import type { SubscriptionManager } from "../../core/subscriptions.js";
import type { RecoverySweepReport } from "../../core/recoverySweep.js";
import { createSession } from "../../core/session.js";
import type { createSendFromTemplatePipeline, createSendPipeline } from "../../core/sendPipeline.js";
import type { createPolicyCommands } from "../../core/policyCommands.js";
import type { createPresenceCommands } from "../../core/presenceCommands.js";
import type { createTemplateCommands } from "../../core/templates.js";
import type { createQueries } from "../../core/queries.js";
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
} from "../../core/validate.js";
import type { ParseResult } from "../../core/validate.js";

export interface CoreStackOptions {
  authority: AuthorityConfig | (Authority & ProvisioningDirectory);
  membership?: MembershipConfig | MembershipSource;
  clock?: ClockIds;
  store?: MessagingStore;
  transports?: PresenceTransport[];
  retryPolicy?: RetryPolicy;
  scheduler?: Scheduler;
  revalidateGraceMs?: number;
  busPollIntervalMs?: number;
  subscriptionBufferMax?: number;
  pushRetryDelayMs?: number;
  sweepIntervalMs?: number;
  effectLegDelayMs?: number;
  membershipDeadlineMs?: number;
}

export interface CoreStack {
  readonly clock: ClockIds;
  readonly store: MessagingStore;
  readonly authority: Authority & ProvisioningDirectory;
  readonly membership: MembershipSource;
  readonly transports: readonly PresenceTransport[];
  readonly transportMap: ReadonlyMap<TransportKind, PresenceTransport>;
  readonly registry: PresenceRegistry;
  readonly orchestrator: DeliveryOrchestrator;
  readonly bus: EventBus;
  readonly subscriptions: SubscriptionManager;
  start(): Promise<void>;
  pumpEvents(): Promise<void>;
  runRecoverySweep(): Promise<RecoverySweepReport>;
  capabilities(protocolVersion: string): CapabilityView;
  authenticate(credential: unknown): Promise<EmbeddedAuthOutcome>;
  buildSession(principal: Principal): MessagingSession;
  close(): Promise<void>;
}

interface StackSessionDeps {
  principal: Principal;
  authority: Authority;
  clock: ClockIds;
  revalidateGraceMs?: number;
  subscriptions: SubscriptionManager;
  sendMessage: ReturnType<typeof createSendPipeline>;
  sendFromTemplate: ReturnType<typeof createSendFromTemplatePipeline>;
  policies: ReturnType<typeof createPolicyCommands>;
  presence: ReturnType<typeof createPresenceCommands>;
  templates: ReturnType<typeof createTemplateCommands>;
  queries: ReturnType<typeof createQueries>;
}

export function createStackSession(deps: StackSessionDeps): MessagingSession {
  const { principal, authority, clock, subscriptions } = deps;
  const session = createSession(principal, {
    authority,
    clock,
    ...(deps.revalidateGraceMs !== undefined ? { graceMs: deps.revalidateGraceMs } : {}),
    onEnded: () => void subscriptions.endForSession(principal.sessionId),
  });

  function door<I, R>(
    parse: (input: unknown) => ParseResult<I>,
    operation: (principal: Principal, input: I) => Promise<R>,
  ): (input: unknown) => Promise<Outcome<R>> {
    return (input) => session.run(async (caller) => {
      const parsed = parse(input);
      if (!parsed.ok) throw parsed.error;
      return operation(caller, parsed.value);
    });
  }

  return {
    get principal() { return session.principal; },
    get state() { return session.state; },
    revalidate: () => session.revalidate(),
    sendMessage: (input) => session.run(async (caller) => {
      const outcome = await deps.sendMessage(caller, input);
      if (outcome.kind === "rejected") throw outcome.error;
      return outcome.result;
    }),
    sendFromTemplate: (input) => session.run(async (caller) => {
      const outcome = await deps.sendFromTemplate(caller, input);
      if (outcome.kind === "rejected") throw outcome.error;
      return outcome.result;
    }),
    openPresence: door(parseOpenPresenceInput, deps.presence.openPresence),
    closePresence: door(parseClosePresenceInput, deps.presence.closePresence),
    setDndPolicy: door(parseSetDndPolicyInput, deps.policies.setDndPolicy),
    setContactPolicy: door(parseSetContactPolicyInput, deps.policies.setContactPolicy),
    upsertTemplate: door(parseUpsertTemplateInput, deps.templates.upsertTemplate),
    retireTemplate: door(parseRetireTemplateInput, deps.templates.retireTemplate),
    getThread: door(parseGetThreadInput, deps.queries.getThread),
    listThreadsForPerson: door(parseListThreadsForPersonInput, deps.queries.listThreadsForPerson),
    getMessages: door(parseGetMessagesInput, deps.queries.getMessages),
    getInbox: door(parseGetInboxInput, deps.queries.getInbox),
    getDelivery: door(parseGetDeliveryInput, deps.queries.getDelivery),
    getPolicy: door(parseGetPolicyInput, deps.queries.getPolicy),
    listTemplates: door(parseListTemplatesInput, deps.queries.listTemplates),
    getPresence: door(parseGetPresenceInput, deps.queries.getPresence),
    subscribe: (input, sink, binding) => session.run(async (caller) => {
      const parsed = parseSubscribeInput(input);
      if (!parsed.ok) throw parsed.error;
      return subscriptions.subscribe(caller, parsed.value, sink, binding);
    }),
  };
}

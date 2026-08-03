// `b3.supervision.*` on the EXISTING nvk-ws v1 frame (§16.2, AMD-001 A-02).
//
// Same rules as every other B3 method table: no second dialect, no field added
// to the socket frame, and every payload validated rather than cast.
//
// TRACER SCOPE. These are the two reads §17.1's `nvk watch list` and
// `nvk watch notifications` need, and nothing else. The rest of §12.4's
// Supervision surface belongs to lanes A, B and C.
//
// The combined `listWatchers` transport response remains a host convenience:
// its rules now come through frozen `listWatchRules`; deadline detail remains
// the tracer's additive read until a public deadline query is required.
import {
  b3err, b3fail, b3ok, isValidClientOpId, mintClientOpId, mintTraceCorrelationId,
  type ActivityGeneration, type AgentRunId, type AuthenticatedPrincipal, type B3Result,
  type CommandContext,
} from '@novakai/foundation/contract';
import {
  parseCreateWatchRuleInput,
  parseNotificationFilter,
  parseResetDriftEpisodeInput,
  parseUpdateWatchRuleInput,
  parseWatchRuleFilter,
  type Notification, type WatchDeadline, type WatchRule,
} from '../../../supervision/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';

export interface B3SupervisionMethodOptions {
  readonly supervision: SupervisionCore;
  readonly principalFor: (session: CallerSession | undefined) => AuthenticatedPrincipal;
  readonly activityGenerationFor: (agentRunId: AgentRunId) => Promise<ActivityGeneration | null>;
}

interface WireParams {
  readonly contractVersion: 1;
  readonly clientOpId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function currentDeadlines(
  deadlines: readonly WatchDeadline[],
  currentGenerationByRule: ReadonlyMap<WatchRule['id'], ActivityGeneration>,
): readonly WatchDeadline[] {
  return deadlines.filter((deadline) => deadline.state !== 'superseded'
    && deadline.activityGeneration === currentGenerationByRule.get(deadline.watchRuleId));
}

const malformed = (): B3Result<never> => b3fail(
  b3err('ValidationFailed', 'params must be {contractVersion, payload}',
    { issues: [{ path: 'params', message: 'missing contractVersion or payload' }] }, false),
);

function readParams(candidate: unknown): B3Result<WireParams> {
  if (typeof candidate !== 'object' || candidate === null) return malformed();
  const params = candidate as Partial<WireParams>;
  if (params.payload === undefined) return malformed();
  if (params.contractVersion !== 1) {
    return b3fail(b3err('UnsupportedContractVersion',
      `contract version ${String(params.contractVersion)} is not supported`,
      { received: params.contractVersion, supported: [1] }, false));
  }
  return b3ok(params as WireParams);
}

function commandContext(
  params: WireParams,
  principal: AuthenticatedPrincipal,
): B3Result<CommandContext> {
  const clientOpId = params.clientOpId ?? mintClientOpId();
  if (!isValidClientOpId(clientOpId)) {
    return b3fail(b3err(
      'ValidationFailed', 'clientOpId must be an op identifier',
      { issues: [{ path: 'clientOpId', message: 'must be op_<uuid>' }] }, false,
    ));
  }
  return b3ok({
    principal,
    clientOpId,
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });
}

function resolveAuthenticatedHuman(
  payload: Readonly<Record<string, unknown>>,
  principal: AuthenticatedPrincipal,
): B3Result<Readonly<Record<string, unknown>>> {
  if (payload.recipient !== 'authenticated-human') return b3ok(payload);
  if (principal.kind !== 'human') {
    return b3fail(b3err(
      'PermissionDenied', 'only a human connection can use the human CLI recipient',
      { operation: 'createWatch' }, false,
    ));
  }
  return b3ok({
    ...payload,
    recipient: { kind: 'human', principalId: principal.id },
  });
}

function completePublishedDriftPolicy(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (typeof payload.condition !== 'object' || payload.condition === null
    || (payload.condition as { readonly kind?: unknown }).kind !== 'activity-drift'
    || typeof payload.driftPolicy !== 'object' || payload.driftPolicy === null) {
    return payload;
  }
  const driftPolicy = payload.driftPolicy as Readonly<Record<string, unknown>>;
  return {
    ...payload,
    driftPolicy: {
      ...driftPolicy,
      statusRecipient: driftPolicy.statusRecipient ?? 'subject-agent',
      statusDeliveryMode: driftPolicy.statusDeliveryMode ?? 'start-turn',
    },
  };
}

function resolveUpdateAuthenticatedHuman(
  payload: Readonly<Record<string, unknown>>,
  principal: AuthenticatedPrincipal,
): B3Result<Readonly<Record<string, unknown>>> {
  if (typeof payload.replacement !== 'object' || payload.replacement === null) {
    return b3ok(payload);
  }
  const resolved = resolveAuthenticatedHuman(
    payload.replacement as Readonly<Record<string, unknown>>,
    principal,
  );
  return resolved.ok
    ? b3ok({ ...payload, replacement: resolved.value })
    : resolved;
}

export interface WatcherListing {
  readonly rules: readonly WatchRule[];
  readonly deadlines: readonly WatchDeadline[];
  readonly nextCursor?: string;
  readonly omissions: readonly { readonly reason: 'permission' | 'unsupported-version'; readonly count: number }[];
}

export function buildB3SupervisionMethods(options: B3SupervisionMethodOptions): MethodTable {
  const { supervision } = options;

  async function listWatchers(
    principal: AuthenticatedPrincipal,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<B3Result<WatcherListing>> {
    const filter = parseWatchRuleFilter({
      ...payload,
      limit: payload.limit ?? 50,
    });
    if (!filter.ok) return filter;
    const rules = await supervision.listWatchRules(principal, filter.value);
    if (!rules.ok) return rules;
    const deadlines = await supervision.listWatchDeadlines(principal);
    if (!deadlines.ok) return deadlines;
    const generations = new Map<WatchRule['id'], ActivityGeneration>();
    await Promise.all(rules.value.items.map(async (rule) => {
      if (rule.subject.kind !== 'agent-run') return;
      const generation = await options.activityGenerationFor(rule.subject.agentRunId);
      if (generation !== null) generations.set(rule.id, generation);
    }));
    return b3ok({
      rules: rules.value.items,
      deadlines: currentDeadlines(deadlines.value, generations),
      ...(rules.value.nextCursor === undefined ? {} : { nextCursor: rules.value.nextCursor }),
      omissions: rules.value.omissions,
    });
  }

  return {
    'b3.supervision.createWatch': async (params, session) => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      const principal = options.principalFor(session);
      const resolved = resolveAuthenticatedHuman(parsed.value.payload, principal);
      if (!resolved.ok) return resolved;
      const input = parseCreateWatchRuleInput(completePublishedDriftPolicy(resolved.value));
      if (!input.ok) return input;
      const context = commandContext(parsed.value, principal);
      return context.ok
        ? supervision.createWatchRule(context.value, input.value)
        : context;
    },

    'b3.supervision.updateWatch': async (params, session) => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      const principal = options.principalFor(session);
      const resolved = resolveUpdateAuthenticatedHuman(parsed.value.payload, principal);
      if (!resolved.ok) return resolved;
      const input = parseUpdateWatchRuleInput(resolved.value);
      if (!input.ok) return input;
      const context = commandContext(parsed.value, principal);
      return context.ok
        ? supervision.updateWatchRule(context.value, input.value)
        : context;
    },

    'b3.supervision.resetDrift': async (params, session) => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      const input = parseResetDriftEpisodeInput(parsed.value.payload);
      if (!input.ok) return input;
      const context = commandContext(parsed.value, options.principalFor(session));
      return context.ok
        ? supervision.resetDriftEpisode(context.value, input.value)
        : context;
    },

    'b3.supervision.listWatchers': async (params, session) => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      return listWatchers(options.principalFor(session), parsed.value.payload);
    },

    'b3.supervision.listNotifications': async (
      params, session,
    ): Promise<B3Result<{ readonly items: readonly Notification[] }>> => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      // The FROZEN filter parser, at the boundary the freeze wrote it for —
      // not a second, laxer opinion about the same payload.
      const filter = parseNotificationFilter(parsed.value.payload);
      if (!filter.ok) return filter;
      return supervision.listNotifications(options.principalFor(session), filter.value);
    },
  };
}

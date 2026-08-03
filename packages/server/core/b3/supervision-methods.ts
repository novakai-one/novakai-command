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
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type ActivityGeneration, type AgentRunId, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  parseNotificationFilter,
  parseNotificationId,
  parseWatchRuleFilter,
  type Notification, type NotificationEventPage, type NotificationId,
  type WatchDeadline, type WatchRule,
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

    // LANE C. Settling a Notification is a mutation, so the id is parsed by the
    // frozen guard rather than trusted: an unknown-shaped id must come back as
    // a typed ValidationFailed, not reach the store as a lookup miss.
    'b3.supervision.acknowledge': async (
      params, session,
    ): Promise<B3Result<Notification>> => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      const notificationId = parseNotificationId(parsed.value.payload['notificationId']);
      if (!notificationId.ok) return notificationId;
      return supervision.acknowledgeNotification(
        {
          principal: options.principalFor(session),
          clientOpId: mintClientOpId(),
          traceId: mintTraceCorrelationId(),
          contractVersion: 1,
        },
        // The frozen guard proves the shape; it returns `unknown` because it is
        // a boolean test wearing a Result, so the brand is applied here.
        notificationId.value as NotificationId,
      );
    },

    // LANE C. Q8: the subscription IS this bounded page on the existing v1
    // request/response frame. Asking again from `after` is the subscription;
    // not asking again is the cancellation. Nothing is held server-side.
    'b3.supervision.subscribeNotifications': async (
      params, session,
    ): Promise<B3Result<NotificationEventPage>> => {
      const parsed = readParams(params);
      if (!parsed.ok) return parsed;
      const payload = parsed.value.payload;
      const limit = Number(payload['limit'] ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        return b3fail(b3err('ValidationFailed', 'limit must be an integer from 1 through 500',
          { issues: [{ path: 'limit', message: 'out of range' }] }, false));
      }
      const after = payload['after'];
      return supervision.notificationEventPage(options.principalFor(session), {
        limit,
        ...(typeof after === 'string' ? { after: after as never } : {}),
      });
    },
  };
}

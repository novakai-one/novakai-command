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
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  parseNotificationFilter,
  parseWatchRuleFilter,
  type Notification, type WatchDeadline, type WatchRule,
} from '../../../supervision/contract/index.js';
import type { SupervisionCore } from '../../../supervision/public/index.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';

export interface B3SupervisionMethodOptions {
  readonly supervision: SupervisionCore;
  readonly principalFor: (session: CallerSession | undefined) => AuthenticatedPrincipal;
}

interface WireParams {
  readonly contractVersion: 1;
  readonly payload: Readonly<Record<string, unknown>>;
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
    return b3ok({ rules: rules.value.items, deadlines: deadlines.value });
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
  };
}

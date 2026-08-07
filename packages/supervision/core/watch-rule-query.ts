import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Page, type B3Result, type EventCursor,
} from '@novakai/foundation/contract';
import {
  subjectKey,
  type WatchRule, type WatchRuleAccess, type WatchRuleFilter,
} from '../contract/index.js';
import type { SupervisionStore } from './store.js';

function matchesFilter(rule: WatchRule, filter: WatchRuleFilter): boolean {
  if (filter.status !== undefined && !filter.status.includes(rule.status)) return false;
  return filter.subject === undefined
    || subjectKey(rule.subject) === subjectKey(filter.subject);
}

function canRead(
  principal: AuthenticatedPrincipal, agentId: string | null, rule: WatchRule,
): boolean {
  if (principal.kind === 'system') return true;
  if (principal.verifiedScopes.includes('supervision:watch:read-all' as never)) return true;
  if (principal.kind === 'human') {
    return rule.createdBy === principal.id
      || (rule.recipient.kind === 'human' && rule.recipient.principalId === principal.id);
  }
  if (principal.kind !== 'agent-run') return false;
  if (rule.subject.kind === 'agent-run' && rule.subject.agentRunId === principal.agentRunId) {
    return true;
  }
  if (agentId === null) return false;
  const isRecipient = rule.recipient.kind === 'agent' && String(rule.recipient.agentId) === agentId;
  const isSubject = rule.subject.kind !== 'agent-run' && String(rule.subject.agentId) === agentId;
  return isRecipient || isSubject;
}

function visibleRules(
  principal: AuthenticatedPrincipal, agentId: string | null, rules: readonly WatchRule[],
): { readonly visible: readonly WatchRule[]; readonly omitted: number } {
  const visible: WatchRule[] = [];
  let omitted = 0;
  for (const rule of rules) {
    if (canRead(principal, agentId, rule)) visible.push(rule);
    else omitted += 1;
  }
  return { visible, omitted };
}

interface CursorPosition { readonly createdAt: string; readonly id: string }

function cursorFor(rule: WatchRule): EventCursor {
  const encoded = Buffer.from(JSON.stringify([rule.createdAt, String(rule.id)]), 'utf8')
    .toString('base64url');
  return `watchRules.${encoded}` as EventCursor;
}

function readCursor(cursor: EventCursor): B3Result<CursorPosition> {
  try {
    if (!String(cursor).startsWith('watchRules.')) throw new Error('wrong prefix');
    const text = Buffer.from(String(cursor).slice(11), 'base64url').toString('utf8');
    const decoded = JSON.parse(text) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') {
      throw new Error('wrong tuple');
    }
    return b3ok({ createdAt: decoded[0], id: decoded[1] });
  } catch {
    return b3fail(b3err(
      'ValidationFailed', 'watch-rule cursor is not a Supervision continuation',
      { issues: [{ path: 'cursor', message: 'is malformed or belongs to another query' }] }, false,
    ));
  }
}

function afterCursor(rule: WatchRule, cursor: CursorPosition): boolean {
  return rule.createdAt > cursor.createdAt
    || (rule.createdAt === cursor.createdAt && String(rule.id) > cursor.id);
}

/** Visibility-aware bounded WatchRule read behind §17.1's canonical list verb. */
export async function listWatchRules(
  store: SupervisionStore,
  access: WatchRuleAccess,
  principal: AuthenticatedPrincipal,
  filter: WatchRuleFilter,
): Promise<B3Result<B3Page<WatchRule>>> {
  const stored = await store.list<WatchRule>('watchRule');
  if (!stored.ok) return b3fail(stored.error);
  const ordered = [...stored.value].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id)));
  const cursor = filter.cursor === undefined ? b3ok(null) : readCursor(filter.cursor);
  if (!cursor.ok) return cursor;
  const continued = cursor.value === null
    ? ordered : ordered.filter((rule) => afterCursor(rule, cursor.value!));
  const filtered = continued.filter((rule) => matchesFilter(rule, filter));
  const identity = await access.agentIdFor(principal);
  if (!identity.ok) return identity;
  const agentId = identity.value === null ? null : String(identity.value);
  const visibility = visibleRules(principal, agentId, filtered);
  const items = visibility.visible.slice(0, filter.limit);
  const nextCursor = items.length < visibility.visible.length ? cursorFor(items.at(-1)!) : undefined;
  return b3ok({
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    omissions: visibility.omitted === 0
      ? [] : [{ reason: 'permission', count: visibility.omitted }],
  });
}

import type { AuthorityScope } from '@novakai/foundation/contract';
import type { WatchRule } from './records.js';

/** Immutable reference to one pinned role watcher template. */
export interface VersionedRef {
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

/** The sole implicit Build 3 watcher-template reference. */
export const ACTIVITY_DRIFT_TEMPLATE_REF: VersionedRef = {
  id: 'watch-template/activity-drift',
  version: 1,
  digest: '0670a8e2dad3c381bf6cf845da23287f568eb105209b391d59a637d1cd0022d4',
};

/** Exact Q5 built-in payload; every other role watcher remains an explicit ref. */
export const ACTIVITY_DRIFT_TEMPLATE = {
  id: 'watch-template/activity-drift',
  version: 1,
  status: 'active',
  subjectBinding: 'current-run',
  condition: {
    kind: 'activity-drift',
    intervalMs: 300_000,
    staleAfterIntervals: 2,
    escalateAfterConsecutive: 3,
  },
  recipientBinding: 'current-supervision-assignment-for-escalation',
  deliveryBinding: 'role.parentNotificationMode-for-escalation',
  cooldownMs: 0,
  driftPolicy: {
    mode: 'cheap-first',
    freeEvidence: ['terminal-liveness', 'transcript-advance', 'usage-delta'],
    statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious',
    statusRecipient: 'subject-agent',
    statusDeliveryMode: 'start-turn',
    replyWindowMs: 300_000,
    statusPrompt: 'Status check: reply with one line — what are you working on right now?',
  },
} as const;

/** Durable role policy resolved into an immutable launch plan before spawn. */
export interface RoleSupervisionPolicy {
  readonly activityDrift: 'required' | 'disabled-explicitly';
  readonly requiredWatcherTemplates: readonly VersionedRef[];
  readonly parentNotificationMode: 'queue-only' | 'next-turn-context' | 'start-turn';
}

/** Scope required to durably authorize watcher-originated start turns. */
export const SUPERVISION_WATCH_START_TURN_SCOPE =
  'supervision:watch:start-turn' as AuthorityScope;

type WatchStartTurnPolicy = Pick<WatchRule, 'status' | 'deliveryMode' | 'condition'>;

/** Whether a non-retired WatchRule requires the durable start-turn scope. */
export function requiresWatchStartTurnAuthority<Rule extends WatchStartTurnPolicy>(
  rule: Rule,
): boolean {
  return rule.status !== 'retired'
    && (rule.deliveryMode === 'start-turn' || rule.condition.kind === 'activity-drift');
}

/** Whether a role policy pins any watcher-originated start-turn authority. */
export function roleRequiresWatchStartTurnAuthority(policy: RoleSupervisionPolicy): boolean {
  return policy.activityDrift === 'required' || policy.parentNotificationMode === 'start-turn';
}

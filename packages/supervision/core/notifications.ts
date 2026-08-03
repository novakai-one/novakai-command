// The event-driven half of the wire: a committed event, and what it settles.
//
// §25-B3d's binding exit is that every one of these paths runs "WITHOUT
// watcher-created model polling turns". Nothing here can start one: the engine
// holds a store and its own contract, and no way to reach a PTY. An ordinary
// event that was already going to be published is the whole clock.
import {
  b3err, b3fail, b3ok, commandReceiptId, deriveClientOpId, deterministicId,
  validationFailed,
  type B3Page, type B3PrincipalId, type B3Result, type CommandReceiptId, type IsoUtc,
  type PublicOperationName,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  parsePublicEvent, SUPERVISION_RECORD_WRITER, watchPairIssue,
  type EvaluateSupervisionEventInput, type Notification, type NotificationFilter,
  type WatchDeadline, type WatchEvaluationProgress, type WatchEvaluationRuleOutcome,
  type WatchRule,
} from '../contract/index.js';
import { conditionNotification } from './condition-notifications.js';
import {
  lifecycleNotificationCandidate, settleLifecycleEventRules,
} from './lifecycle-notifications.js';
import { commitOrdinaryNotification } from './ordinary-notification-commit.js';
import type { SupervisionStore } from './store.js';
import {
  settleUsageThresholdRules, usageThresholdCandidateForEvent,
  type UsageThresholdDependencies,
} from './usage-threshold-notifications.js';
import { claimDeadline } from './watchers/deadlines.js';
import { armOrdinaryDeadlineAt } from './watchers.js';
import {
  advanceProgressRecovery, appendProgressOutcome, beginProgressAttempt,
  finishProgress, startDeadlineEvaluation, startEventEvaluation,
} from './watch-evaluation-progress.js';
import type { WatchOccurrenceRelationshipAuthority } from '../contract/api.js';
import { rebindDeliveryFences } from './delivery-fences.js';

export interface EvaluateDependencies extends UsageThresholdDependencies {
  readonly store: SupervisionStore;
  readonly relationships?: WatchOccurrenceRelationshipAuthority;
}

type EvaluationContext = SystemCommandContext<
  'sys_agents' | 'sys_agent_runtime' | 'sys_transcript' | 'sys_messaging'
>;

/** The subject key an event is evidence ABOUT, or null when it names none. */
function subjectKeyOfEvent(payload: Readonly<Record<string, unknown>>): string | null {
  const agentRunId = payload['agentRunId'];
  return typeof agentRunId === 'string' ? `agent-run:${agentRunId}` : null;
}

/**
 * Fire one due deadline and queue its Notification, exactly once.
 *
 * QUEUE FIRST, then stop being armed. The two orders are indistinguishable
 * when nothing goes wrong and differ exactly once — a crash between them.
 * Firing first loses the alert for ever: the deadline is no longer armed, so
 * no replay will ever queue it. Queueing first can at worst re-fire a deadline
 * whose Notification already exists, and its deterministic identity absorbs
 * that. Same reason the freeze pins queue-before-delivery at the C seam.
 */
async function fireDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  observedAt: IsoUtc,
  evidenceRef: string,
  receiptId: CommandReceiptId,
): Promise<B3Result<Notification | null>> {
  if (input.deadline.creationRecordVersion === undefined
    || input.deadline.armingOrdinal === undefined) {
    return b3fail(b3err(
      'RecoveryRequired',
      `ordinary deadline ${String(input.deadline.id)} lacks immutable arming identity`,
      {
        operationId: receiptId,
        reason: `WatchDeadline ${String(input.deadline.id)} is missing `
          + `${input.deadline.creationRecordVersion === undefined
            ? 'creationRecordVersion'
            : 'armingOrdinal'}`,
      },
      true,
    ));
  }
  const started = await startDeadlineEvaluation(deps.store, principal, {
    commandReceiptId: receiptId,
    deadline: input.deadline as WatchDeadline & {
      readonly creationRecordVersion: NonNullable<WatchDeadline['creationRecordVersion']>;
    },
  });
  if (!started.ok) return started;
  let progress = started.value;
  let queued: Notification | null = null;
  if (progress.state !== 'completed') {
    const begun = await beginProgressAttempt(deps.store, principal, progress);
    if (!begun.ok) return begun;
    progress = begun.value;
  const record = conditionNotification(
    principal,
    input.rule,
    input.deadline.subjectKey,
    input.deadline.activityGeneration,
    evidenceRef,
    { occurrenceIdentity: 'legacy-generation', qualifiedAt: input.deadline.dueAt },
  );
    const committed = await commitOrdinaryNotification(
      deps,
      { id: principal, kind: 'system', verifiedScopes: [] },
      input.rule,
      record,
      progress.id,
    );
    if (!committed.ok) {
      const details = committed.error.details as Readonly<Record<string, unknown>>;
      const stage = details['stage'] === 'legacy-occurrence-adoption'
        ? 'legacy-occurrence-adoption'
        : details['stage'] === 'rule-version-fence'
          ? 'rule-version-fence'
          : 'occurrence-derivation';
      const recovery = { stage, reason: committed.error.message } as const;
      const finished = await finishProgress(deps.store, principal, progress, recovery);
      return finished.ok ? b3fail(committed.error) : finished;
    }
    queued = committed.value.notification ?? null;
    const recorded = await appendProgressOutcome(
      deps.store,
      principal,
      progress,
      {
        watchRuleId: input.rule.id,
        evaluatedRecordVersion: input.rule.recordVersion,
        outcome: committed.value.outcome,
      },
    );
    if (!recorded.ok) return recorded;
    const finished = await finishProgress(deps.store, principal, recorded.value);
    if (!finished.ok) return finished;
  }
  const claimed = await claimDeadline({
    store: deps.store,
    clock: () => new Date(observedAt),
  }, input.deadline);
  if (!claimed.ok) return b3fail(claimed.error);
  const lateByMs = Math.max(
    0, new Date(observedAt).getTime() - new Date(input.deadline.dueAt).getTime(),
  );
  const fired = await deps.store.update<WatchDeadline>(
    principal, claimed.value.id, { state: 'fired', lateByMs },
    claimed.value.recordVersion, deriveClientOpId(`b3v4:fire-deadline:${claimed.value.id}`),
  );
  if (!fired.ok) return b3fail(fired.error);
  return b3ok(queued);
}

/** Push an idle deadline out; observed activity is why it has not fired. */
async function rearmDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  event: ObservedEvent,
): Promise<B3Result<null>> {
  if (input.rule.condition.kind !== 'idle-for-ms') return b3ok(null);
  if (event.activityGeneration === null
    || Number(event.activityGeneration) <= Number(input.deadline.activityGeneration)) {
    return b3ok(null);
  }
  const dueAt = new Date(
    new Date(event.observedAt).getTime() + input.rule.condition.value,
  ).toISOString();
  return armOrdinaryDeadlineAt(
    deps,
    principal,
    input.rule,
    event.activityGeneration,
    dueAt as IsoUtc,
    true,
  );
}

/** The three facts a committed event contributes to a watcher evaluation. */
interface ObservedEvent {
  readonly observedAt: IsoUtc;
  readonly evidenceRef: string;
  readonly about: string | null;
  readonly activityGeneration: import('@novakai/foundation/contract').ActivityGeneration | null;
  readonly commandReceiptId: CommandReceiptId;
}

/** What one armed deadline does about one committed event. */
async function settleDeadline(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  input: { readonly rule: WatchRule; readonly deadline: WatchDeadline },
  event: ObservedEvent,
): Promise<B3Result<Notification | null>> {
  if (String(event.observedAt) >= String(input.deadline.dueAt)) {
    return fireDeadline(
      deps, principal, input, event.observedAt, event.evidenceRef, event.commandReceiptId,
    );
  }
  if (event.about !== input.deadline.subjectKey) return b3ok(null);
  const rearmed = await rearmDeadline(deps, principal, input, event);
  return rearmed.ok ? b3ok(null) : b3fail(rearmed.error);
}

/** One armed deadline, resolved against its own rule before it is settled. */
async function settleOne(
  deps: EvaluateDependencies,
  principal: B3PrincipalId,
  deadline: WatchDeadline,
  event: ObservedEvent,
): Promise<B3Result<Notification | null>> {
  const rule = await deps.store.read<WatchRule>('watchRule', deadline.watchRuleId);
  if (!rule.ok) return b3fail(rule.error);
  if (rule.value === null || rule.value.status !== 'active') return b3ok(null);
  // Activity drift has its own evidence reducer, clocks, and fenced scheduler
  // command. Letting the generic event path settle it would skip all nine
  // durable drift steps and manufacture an ordinary condition notification.
  if (rule.value.condition.kind === 'activity-drift') return b3ok(null);
  return settleDeadline(deps, principal, { rule: rule.value, deadline }, event);
}

async function settleArmedDeadlines(
  deps: EvaluateDependencies,
  deadlines: readonly WatchDeadline[],
  event: ObservedEvent,
): Promise<B3Result<readonly Notification[]>> {
  const queued: Notification[] = [];
  for (const deadline of deadlines) {
    const settled = await settleOne(deps, SUPERVISION_RECORD_WRITER, deadline, event);
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}

/**
 * The reducer §9.2 asks for: at-least-once committed events in, durable
 * Notifications out, and nothing in between that can talk to a model.
 */
export async function evaluateEvent(
  deps: EvaluateDependencies,
  _context: EvaluationContext,
  input: EvaluateSupervisionEventInput,
): Promise<B3Result<readonly Notification[]>> {
  const parsed = parsePublicEvent(input.event);
  if (!parsed.ok) {
    return b3fail(validationFailed([{ path: 'event', message: parsed.error.message }]));
  }
  const receiptId = commandReceiptId(
    _context.principal.id,
    'supervision.evaluateEvent' as PublicOperationName,
    _context.clientOpId,
  );
  const armed = await deps.store.list<WatchDeadline>('watchDeadline', { state: 'armed' });
  if (!armed.ok) return b3fail(armed.error);
  const event = {
    observedAt: parsed.value.occurredAt,
    evidenceRef: parsed.value.eventId,
    qualifiedAt: parsed.value.occurredAt,
    about: subjectKeyOfEvent(parsed.value.payload),
    activityGeneration: Number.isSafeInteger(parsed.value.payload['activityGeneration'])
      && Number(parsed.value.payload['activityGeneration']) >= 0
      ? parsed.value.payload['activityGeneration'] as import('@novakai/foundation/contract').ActivityGeneration
      : null,
    commandReceiptId: receiptId,
  };
  const deadlineNotifications = await settleArmedDeadlines(deps, armed.value, event);
  if (!deadlineNotifications.ok) return deadlineNotifications;
  const rules = await deps.store.list<WatchRule>('watchRule');
  if (!rules.ok) return b3fail(rules.error);
  const started = await startEventEvaluation(deps.store, SUPERVISION_RECORD_WRITER, {
    commandReceiptId: receiptId,
    eventId: parsed.value.eventId,
    orderedWatchRuleIds: rules.value.map((rule) => rule.id),
  });
  if (!started.ok) return started;
  if (started.value.state === 'completed') {
    return b3ok(deadlineNotifications.value);
  }
  const begun = await beginProgressAttempt(deps.store, SUPERVISION_RECORD_WRITER, started.value);
  if (!begun.ok) return begun;
  let progress = begun.value;
  const queued: Notification[] = [...deadlineNotifications.value];
  let isolatedRecovery: WatchEvaluationProgress['recovery'];
  const lifecycleEvent = {
    kind: parsed.value.kind,
    payload: parsed.value.payload,
    evidenceRef: parsed.value.eventId,
    qualifiedAt: parsed.value.occurredAt,
    about: event.about,
  };

  for (const watchRuleId of progress.orderedWatchRuleIds) {
    const priorCommit = [...progress.completed].reverse().find((entry): entry is typeof entry & {
      readonly outcome: Extract<WatchEvaluationRuleOutcome, {
        readonly kind: 'committed' | 'adopted' | 'legacy-adopted';
      }>;
    } => entry.watchRuleId === watchRuleId
      && ['committed', 'adopted', 'legacy-adopted'].includes(entry.outcome.kind));
    const current = await deps.store.read<WatchRule>('watchRule', watchRuleId);
    if (!current.ok) return current;
    if (current.value === null) continue;
    const rule = current.value;
    if (priorCommit !== undefined) {
      const outcome = priorCommit.outcome.kind === 'legacy-adopted'
        ? priorCommit.outcome
        : { kind: 'adopted' as const, notificationId: priorCommit.outcome.notificationId };
      if (priorCommit.outcome.kind === 'committed') {
        const notification = await deps.store.read<Notification>(
          'notification', priorCommit.outcome.notificationId,
        );
        if (!notification.ok) return notification;
        if (notification.value !== null) queued.push(notification.value);
      }
      const recorded = await appendProgressOutcome(
        deps.store, SUPERVISION_RECORD_WRITER, progress,
        { watchRuleId, evaluatedRecordVersion: rule.recordVersion, outcome },
      );
      if (!recorded.ok) return recorded;
      progress = recorded.value;
      continue;
    }
    let outcome: WatchEvaluationRuleOutcome;
    if (rule.status !== 'active') {
      outcome = { kind: 'inactive-current-policy' };
    } else {
      const issue = watchPairIssue(rule.subject, rule.condition);
      if (issue !== null) {
        outcome = {
          kind: 'pair-not-admitted',
          signalEventId: deterministicId('event', [
            'watch-rule-admission-signal', progress.id, rule.id, String(rule.recordVersion),
          ]),
          signalOccurredAt: progress.createdAt,
          signalTraceId: _context.traceId,
          subject: rule.subject,
          condition: rule.condition,
          reason: issue.issue,
        };
      } else {
        const usageCandidate = await usageThresholdCandidateForEvent(
          deps, _context.principal, rule, parsed.value,
        );
        let candidate = usageCandidate;
        if (usageCandidate.ok && usageCandidate.value === null) {
          candidate = await lifecycleNotificationCandidate(
            deps, _context.principal, rule, lifecycleEvent,
          );
        }
        if (!candidate.ok) {
          if (!candidate.error.retryable) {
            outcome = {
              kind: 'failed-non-retryable',
              code: candidate.error.code,
              reason: candidate.error.message,
              details: candidate.error.details,
            };
          } else {
            const details = candidate.error.details as Readonly<Record<string, unknown>>;
            const stage = details['stage'] === 'legacy-occurrence-adoption'
              ? 'legacy-occurrence-adoption'
              : details['stage'] === 'rule-version-fence'
                ? 'rule-version-fence'
                : 'occurrence-derivation';
            const recovery = {
              stage,
              reason: `${String(rule.id)}: ${candidate.error.message}`,
            } as const;
            const advanced = await advanceProgressRecovery(
              deps.store, SUPERVISION_RECORD_WRITER, progress, recovery,
            );
            if (!advanced.ok) return advanced;
            progress = advanced.value;
            isolatedRecovery ??= recovery;
            if (stage === 'legacy-occurrence-adoption') continue;
            const finished = await finishProgress(
              deps.store, SUPERVISION_RECORD_WRITER, progress, isolatedRecovery,
            );
            if (!finished.ok) return finished;
            return b3fail(candidate.error);
          }
        } else if (candidate.value === null) {
          outcome = { kind: 'not-matching' };
        } else {
          const committed = await commitOrdinaryNotification(
            deps, _context.principal, rule, candidate.value, progress.id,
          );
          if (!committed.ok) {
            if (!committed.error.retryable) {
              outcome = {
                kind: 'failed-non-retryable',
                code: committed.error.code,
                reason: committed.error.message,
                details: committed.error.details,
              };
            } else {
              const details = committed.error.details as Readonly<Record<string, unknown>>;
              const stage = details['stage'] === 'legacy-occurrence-adoption'
                ? 'legacy-occurrence-adoption'
                : details['stage'] === 'rule-version-fence'
                  ? 'rule-version-fence'
                  : 'occurrence-derivation';
              const recovery = {
                stage,
                reason: `${String(rule.id)}: ${committed.error.message}`,
              } as const;
              const advanced = await advanceProgressRecovery(
                deps.store, SUPERVISION_RECORD_WRITER, progress, recovery,
              );
              if (!advanced.ok) return advanced;
              progress = advanced.value;
              isolatedRecovery ??= recovery;
              if (stage === 'legacy-occurrence-adoption') continue;
              const finished = await finishProgress(
                deps.store, SUPERVISION_RECORD_WRITER, progress, isolatedRecovery,
              );
              if (!finished.ok) return finished;
              return b3fail(committed.error);
            }
          } else {
            outcome = committed.value.outcome;
            if (committed.value.notification !== undefined) {
              queued.push(committed.value.notification);
            }
          }
        }
      }
    }
    const recorded = await appendProgressOutcome(
      deps.store, SUPERVISION_RECORD_WRITER, progress,
      { watchRuleId, evaluatedRecordVersion: rule.recordVersion, outcome: outcome! },
    );
    if (!recorded.ok) return recorded;
    progress = recorded.value;
  }
  const rebound = await rebindDeliveryFences(deps, _context.principal, {
    eventId: parsed.value.eventId,
    kind: parsed.value.kind,
    occurredAt: parsed.value.occurredAt,
  });
  if (!rebound.ok) return rebound;
  const finished = await finishProgress(
    deps.store, SUPERVISION_RECORD_WRITER, progress, isolatedRecovery,
  );
  if (!finished.ok) return finished;
  if (isolatedRecovery !== undefined) {
    return b3fail(b3err(
      'RecoveryRequired', isolatedRecovery.reason,
      { operationId: progress.id, ...isolatedRecovery }, true,
    ));
  }
  return b3ok(queued);
}

/**
 * Settle clock-driven idle work even when the Runtime is otherwise silent.
 *
 * This is an embedded-host seam, not another public command. The durable
 * deadline remains the authority: every pass re-reads armed rows, claims the
 * exact record version, and the deterministic Notification absorbs replay.
 */
export async function evaluateDueDeadlines(
  deps: EvaluateDependencies,
  observedAt: IsoUtc,
  receiptId: CommandReceiptId,
): Promise<B3Result<readonly Notification[]>> {
  const deadlines = await deps.store.list<WatchDeadline>('watchDeadline');
  if (!deadlines.ok) return b3fail(deadlines.error);
  const dueDeadlines = deadlines.value
    .filter((deadline) => deadline.state === 'armed' || deadline.state === 'claimed')
    .filter((deadline) => String(deadline.dueAt) <= String(observedAt))
    .sort((left, right) => String(left.dueAt).localeCompare(String(right.dueAt))
      || String(left.id).localeCompare(String(right.id)));
  const queued: Notification[] = [];
  for (const deadline of dueDeadlines) {
    const settled = await settleOne(deps, SUPERVISION_RECORD_WRITER, deadline, {
      observedAt,
      evidenceRef: `watch-deadline:${String(deadline.id)}:due:${String(deadline.dueAt)}`,
      about: null,
      activityGeneration: null,
      commandReceiptId: receiptId,
    });
    if (!settled.ok) return b3fail(settled.error);
    if (settled.value !== null) queued.push(settled.value);
  }
  return b3ok(queued);
}

/** §12.4's durable notification read, filtered and bounded. */
export async function listNotifications(
  deps: EvaluateDependencies, filter: NotificationFilter,
): Promise<B3Result<B3Page<Notification>>> {
  const stored = await deps.store.list<Notification>('notification');
  if (!stored.ok) return b3fail(stored.error);
  const wanted = stored.value.filter((notification) => {
    if (filter.state !== undefined && !filter.state.includes(notification.state)) return false;
    if (filter.recipient === undefined) return true;
    return JSON.stringify(notification.recipient) === JSON.stringify(filter.recipient);
  });
  return b3ok({ items: wanted.slice(0, filter.limit), omissions: [] });
}

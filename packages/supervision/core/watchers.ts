// Installing a Run's role watchers, and arming what they wait on (§9.2, §13.5).
//
// This is the spawn-side half of the wire. A governed Run reaches `ready` with
// its watchers already standing, or the spawn ladder says why it did not — the
// B3c failure mode was a stage recorded `not-needed` for ever.
import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type B3Page, type B3PrincipalId, type B3Result, type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveWatchDeadlineId, mintWatchRuleId, subjectKey,
  type InstallRunWatchersInput, type NotificationRecipient, type VersionedRef,
  type WatchDeadline, type WatchRule, type WatchRuleFilter, type WatchSubject,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import type { WatcherTemplate, WatcherTemplatePort } from './templates.js';

export interface InstallDependencies {
  readonly store: SupervisionStore;
  readonly templates: WatcherTemplatePort;
  readonly clock: () => Date;
  /** Who a fired watcher tells. Resolved per Run; see `compose.ts`. */
  readonly recipientFor: (input: InstallRunWatchersInput) => Promise<NotificationRecipient>;
  /**
   * The Run's activity generation. The frozen install input carries none and
   * Supervision publishes no query for one, so the host answers it.
   */
  readonly generationFor: (input: InstallRunWatchersInput) => Promise<ActivityGeneration>;
}

const unresolvable = (templateRef: VersionedRef): ReturnType<typeof b3err> => b3err(
  'WatchRuleInvalid',
  `no watcher template answers ${templateRef.id}@${String(templateRef.version)} at that digest`,
  { templateId: templateRef.id, templateVersion: templateRef.version, digest: templateRef.digest },
  false,
);

/** The one effect key an install repeats under, so a retry adopts its rule. */
const installEffectKey = (input: InstallRunWatchersInput, templateRef: VersionedRef): string =>
  `b3v4:install-run-watchers:${String(input.agentRunId)}:${templateRef.id}@${String(templateRef.version)}`;

function ruleRecord(
  principal: B3PrincipalId,
  template: WatcherTemplate,
  subject: WatchSubject,
  recipient: NotificationRecipient,
): Persisted<WatchRule> & Record<string, unknown> {
  return {
    kind: 'watchRule',
    id: mintWatchRuleId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    subject,
    condition: template.condition,
    recipient,
    deliveryMode: template.deliveryMode,
    cooldownMs: template.cooldownMs,
    status: 'active',
    ...(template.driftPolicy === undefined ? {} : { driftPolicy: template.driftPolicy }),
  };
}

/**
 * How long a rule waits before it is due, or `null` when the rule is not the
 * kind that waits on a clock at all.
 *
 * Only `idle-for-ms` arms here. An activity-drift deadline additionally carries
 * the durable §9.2 drift state, and its exact 1–9 algorithm is lane B's; arming
 * one without that state would write a record its own frozen parser refuses.
 */
function waitMsOf(rule: WatchRule): number | null {
  return rule.condition.kind === 'idle-for-ms' ? rule.condition.value : null;
}

function deadlineRecord(
  principal: B3PrincipalId,
  rule: WatchRule,
  generation: ActivityGeneration,
  dueAt: IsoUtc,
): Persisted<WatchDeadline> & Record<string, unknown> {
  const keyed = subjectKey(rule.subject);
  return {
    kind: 'watchDeadline',
    id: deriveWatchDeadlineId({
      watchRuleId: rule.id, subjectKey: keyed, activityGeneration: generation,
    }),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: principal,
    watchRuleId: rule.id,
    subjectKey: keyed,
    activityGeneration: generation,
    dueAt,
    state: 'armed',
  };
}

/** Arm one rule's deadline, or report that this rule waits on nothing. */
async function armDeadline(
  deps: InstallDependencies,
  principal: B3PrincipalId,
  rule: WatchRule,
  generation: ActivityGeneration,
): Promise<B3Result<null>> {
  const waitMs = waitMsOf(rule);
  if (waitMs === null) return b3ok(null);
  const dueAt = new Date(deps.clock().getTime() + waitMs).toISOString() as IsoUtc;
  const record = deadlineRecord(principal, rule, generation, dueAt);
  const existing = await deps.store.read<WatchDeadline>('watchDeadline', record.id);
  if (!existing.ok) return existing;
  if (existing.value !== null) return b3ok(null);
  const written = await deps.store.create<WatchDeadline>(
    principal, record, deriveClientOpId(`b3v4:arm-deadline:${record.id}`),
  );
  return written.ok ? b3ok(null) : b3fail(written.error);
}

/**
 * §13.5's watcher rung, for real.
 *
 * Every pinned ref resolves or the whole install is refused: a Run that reaches
 * `ready` under half its role's watchers is exactly the "silently unsupervised"
 * state §25-B3d exists to end.
 */
export async function installRunWatchers(
  deps: InstallDependencies,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: InstallRunWatchersInput,
): Promise<B3Result<readonly WatchRule[]>> {
  const templates: WatcherTemplate[] = [];
  for (const templateRef of input.requiredTemplateRefs) {
    const resolved = deps.templates.resolve(templateRef);
    if (resolved === null) return b3fail(unresolvable(templateRef));
    templates.push(resolved);
  }
  const recipient = await deps.recipientFor(input);
  const generation = await deps.generationFor(input);
  const subject: WatchSubject = { kind: 'agent-run', agentRunId: input.agentRunId };
  const installed: WatchRule[] = [];
  for (const template of templates) {
    const written = await deps.store.create<WatchRule>(
      context.principal.id,
      ruleRecord(context.principal.id, template, subject, recipient),
      deriveClientOpId(installEffectKey(input, template.templateRef)),
    );
    if (!written.ok) return written;
    const armed = await armDeadline(deps, context.principal.id, written.value, generation);
    if (!armed.ok) return b3fail(armed.error);
    installed.push(written.value);
  }
  return b3ok(installed);
}

/** Visibility-aware bounded WatchRule read behind §17.1's canonical list verb. */
export async function listWatchRules(
  store: SupervisionStore,
  filter: WatchRuleFilter,
): Promise<B3Result<B3Page<WatchRule>>> {
  const stored = await store.list<WatchRule>('watchRule');
  if (!stored.ok) return b3fail(stored.error);
  const wanted = stored.value.filter((rule) => {
    if (filter.status !== undefined && !filter.status.includes(rule.status)) return false;
    if (filter.subject === undefined) return true;
    return subjectKey(rule.subject) === subjectKey(filter.subject);
  });
  return b3ok({ items: wanted.slice(0, filter.limit), omissions: [] });
}

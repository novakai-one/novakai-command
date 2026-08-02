// Installing a Run's role watchers, and arming what they wait on (§9.2, §13.5).
//
// This is the spawn-side half of the wire. A governed Run reaches `ready` with
// its watchers already standing, or the spawn ladder says why it did not — the
// B3c failure mode was a stage recorded `not-needed` for ever.
import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type AuthenticatedPrincipal, type B3Page, type B3PrincipalId,
  type B3Result, type EventCursor, type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveWatchDeadlineId, mintWatchRuleId, subjectKey, SUPERVISION_RECORD_WRITER,
  ACTIVITY_DRIFT_TEMPLATE_REF,
  type InstallRunWatchersInput, type NotificationRecipient, type VersionedRef,
  type ResolvedWatcherInstall, type WatcherInstallAuthority,
  type WatchDeadline, type WatcherTemplate, type WatcherTemplateCatalogue,
  type WatchRule, type WatchRuleFilter, type WatchSubject,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import { templateDigest } from './templates.js';

export interface InstallDependencies {
  readonly store: SupervisionStore;
  readonly templates: WatcherTemplateCatalogue;
  readonly authority: WatcherInstallAuthority;
  readonly clock: () => Date;
}

const unresolvable = (templateRef: VersionedRef): ReturnType<typeof b3err> => b3err(
  'WatchRuleInvalid',
  `no watcher template answers ${templateRef.id}@${String(templateRef.version)} at that digest`,
  { templateId: templateRef.id, templateVersion: templateRef.version, digest: templateRef.digest },
  false,
);

/** The one effect key an install repeats under, so a retry adopts its rule. */
const recipientKey = (recipient: NotificationRecipient): string => recipient.kind === 'agent'
  ? `agent:${String(recipient.agentId)}`
  : `human:${String(recipient.principalId)}`;

const installEffectKey = (input: InstallRunWatchersInput, templateRef: VersionedRef): string => [
  'b3v4:install-run-watchers', String(input.agentRunId), String(input.launchPlanId),
  `${templateRef.id}@${String(templateRef.version)}#${templateRef.digest}`,
  recipientKey(input.recipient), String(input.activityGeneration),
].join(':');

function ruleRecord(
  context: SystemCommandContext<'sys_agent_runtime'>,
  template: WatcherTemplate,
  plan: ResolvedWatcherInstall,
  subject: WatchSubject,
): Persisted<WatchRule> & Record<string, unknown> {
  const deliveryMode = template.payload.deliveryBinding === 'role.parentNotificationMode-for-escalation'
    ? plan.parentNotificationMode
    : template.payload.deliveryBinding;
  return {
    kind: 'watchRule',
    id: mintWatchRuleId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: SUPERVISION_RECORD_WRITER,
    subject,
    condition: template.payload.condition,
    recipient: plan.recipient,
    deliveryMode,
    cooldownMs: template.payload.cooldownMs,
    status: 'active',
    ...(template.payload.driftPolicy === undefined ? {} : { driftPolicy: template.payload.driftPolicy }),
    installation: {
      launchPlanId: plan.launchPlanId,
      templateRef: template.templateRef,
      activityGeneration: plan.activityGeneration,
      requestedBy: context.principal.id,
      requestTraceId: context.traceId,
      requestClientOpId: context.clientOpId,
    },
  };
}

const sameRef = (left: VersionedRef, right: VersionedRef): boolean =>
  left.id === right.id && left.version === right.version && left.digest === right.digest;

const sameRecipient = (left: NotificationRecipient, right: NotificationRecipient): boolean =>
  recipientKey(left) === recipientKey(right);

function installMatches(input: InstallRunWatchersInput, plan: ResolvedWatcherInstall): boolean {
  return input.agentRunId === plan.agentRunId
    && input.launchPlanId === plan.launchPlanId
    && input.activityGeneration === plan.activityGeneration
    && sameRecipient(input.recipient, plan.recipient)
    && input.requiredTemplateRefs.length === plan.requiredTemplateRefs.length
    && input.requiredTemplateRefs.every((templateRef, index) =>
      sameRef(templateRef, plan.requiredTemplateRefs[index]!));
}

function requiredRefs(plan: ResolvedWatcherInstall): readonly VersionedRef[] {
  return plan.activityDrift === 'required'
    ? [ACTIVITY_DRIFT_TEMPLATE_REF, ...plan.requiredTemplateRefs]
    : plan.requiredTemplateRefs;
}

function resolveTemplates(
  catalogue: WatcherTemplateCatalogue,
  plan: ResolvedWatcherInstall,
): B3Result<readonly WatcherTemplate[]> {
  const templates: WatcherTemplate[] = [];
  for (const templateRef of requiredRefs(plan)) {
    const resolved = catalogue.resolve(templateRef);
    const valid = resolved !== null
      && sameRef(resolved.templateRef, templateRef)
      && resolved.payload.id === templateRef.id
      && resolved.payload.version === templateRef.version
      && templateDigest(resolved.payload) === templateRef.digest;
    if (!valid || resolved === null) return b3fail(unresolvable(templateRef));
    templates.push(resolved);
  }
  return b3ok(templates);
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
    SUPERVISION_RECORD_WRITER,
    record,
    deriveClientOpId(`b3v4:arm-deadline:${record.id}`),
  );
  return written.ok ? b3ok(null) : b3fail(written.error);
}

function matchingInstalledRule(
  rules: readonly WatchRule[],
  input: InstallRunWatchersInput,
  template: WatcherTemplate,
): WatchRule | undefined {
  return rules.find((rule) => rule.subject.kind === 'agent-run'
    && rule.subject.agentRunId === input.agentRunId
    && rule.installation?.templateRef.id === template.templateRef.id);
}

function priorMatches(
  prior: WatchRule,
  input: InstallRunWatchersInput,
  template: WatcherTemplate,
): boolean {
  return prior.installation !== undefined
    && sameRef(prior.installation.templateRef, template.templateRef)
    && prior.installation.launchPlanId === input.launchPlanId
    && prior.installation.activityGeneration === input.activityGeneration
    && sameRecipient(prior.recipient, input.recipient);
}

async function installTemplate(
  deps: InstallDependencies,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: InstallRunWatchersInput,
  plan: ResolvedWatcherInstall,
  existing: readonly WatchRule[],
  template: WatcherTemplate,
): Promise<B3Result<WatchRule>> {
  const prior = matchingInstalledRule(existing, input, template);
  if (prior !== undefined && !priorMatches(prior, input, template)) {
    return b3fail(b3err(
      'IdempotencyConflict',
      'this Run already has a watcher installed from different pinned facts',
      { watchRuleId: prior.id, templateId: template.templateRef.id },
      false,
    ));
  }
  const subject: WatchSubject = { kind: 'agent-run', agentRunId: input.agentRunId };
  const written = prior === undefined
    ? await deps.store.create<WatchRule>(
      SUPERVISION_RECORD_WRITER,
      ruleRecord(context, template, plan, subject),
      deriveClientOpId(installEffectKey(input, template.templateRef)),
    )
    : b3ok(prior);
  if (!written.ok) return written;
  const armed = await armDeadline(
    deps, SUPERVISION_RECORD_WRITER, written.value, input.activityGeneration,
  );
  return armed.ok ? b3ok(written.value) : b3fail(armed.error);
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
  const authority = await deps.authority.resolve(context.principal, input);
  if (!authority.ok) return authority;
  if (!installMatches(input, authority.value)) {
    return b3fail(b3err(
      'IdempotencyConflict',
      'watcher install facts do not match the authoritative launch plan and Run',
      { agentRunId: input.agentRunId, launchPlanId: input.launchPlanId },
      false,
    ));
  }
  const templates = resolveTemplates(deps.templates, authority.value);
  if (!templates.ok) return templates;
  const installed: WatchRule[] = [];
  const existing = await deps.store.list<WatchRule>('watchRule');
  if (!existing.ok) return existing;
  for (const template of templates.value) {
    const written = await installTemplate(
      deps, context, input, authority.value, existing.value, template,
    );
    if (!written.ok) return written;
    installed.push(written.value);
  }
  return b3ok(installed);
}

function matchesWatchRuleFilter(rule: WatchRule, filter: WatchRuleFilter): boolean {
  if (filter.status !== undefined && !filter.status.includes(rule.status)) return false;
  return filter.subject === undefined
    || subjectKey(rule.subject) === subjectKey(filter.subject);
}

function canReadWatchRule(principal: AuthenticatedPrincipal, rule: WatchRule): boolean {
  if (principal.kind === 'system') return true;
  if (principal.verifiedScopes.includes('supervision:watch:read-all' as never)) return true;
  if (principal.kind === 'human') {
    return rule.recipient.kind === 'human' && rule.recipient.principalId === principal.id;
  }
  return principal.kind === 'agent-run'
    && rule.subject.kind === 'agent-run'
    && rule.subject.agentRunId === principal.agentRunId;
}

function visibleRules(
  principal: AuthenticatedPrincipal,
  rules: readonly WatchRule[],
): { readonly visible: readonly WatchRule[]; readonly omitted: number } {
  const visible: WatchRule[] = [];
  let omitted = 0;
  for (const rule of rules) {
    if (canReadWatchRule(principal, rule)) visible.push(rule);
    else omitted += 1;
  }
  return { visible, omitted };
}

/** Visibility-aware bounded WatchRule read behind §17.1's canonical list verb. */
export async function listWatchRules(
  store: SupervisionStore,
  principal: AuthenticatedPrincipal,
  filter: WatchRuleFilter,
): Promise<B3Result<B3Page<WatchRule>>> {
  const stored = await store.list<WatchRule>('watchRule');
  if (!stored.ok) return b3fail(stored.error);
  const filtered = stored.value.filter((rule) => matchesWatchRuleFilter(rule, filter));
  const ordered = [...filtered].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id)));
  const access = visibleRules(principal, ordered);
  const start = filter.cursor === undefined
    ? 0
    : access.visible.findIndex((rule) => String(rule.id) === String(filter.cursor)) + 1;
  if (filter.cursor !== undefined && start === 0) {
    return b3fail(b3err(
      'ValidationFailed', 'watch-rule cursor does not name a visible prior item',
      { issues: [{ path: 'cursor', message: 'is unknown or no longer visible' }] }, false,
    ));
  }
  const items = access.visible.slice(start, start + filter.limit);
  const hasMore = start + items.length < access.visible.length;
  const nextCursor = hasMore ? String(items.at(-1)?.id) as EventCursor : undefined;
  return b3ok({
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    omissions: access.omitted === 0 ? [] : [{ reason: 'permission', count: access.omitted }],
  });
}

// Installing a Run's role watchers, and arming what they wait on (§9.2, §13.5).
//
// This is the spawn-side half of the wire. A governed Run reaches `ready` with
// its watchers already standing, or the spawn ladder says why it did not — the
// B3c failure mode was a stage recorded `not-needed` for ever.
import {
  b3err, b3fail, b3ok, deriveClientOpId, nowIsoUtc,
  type ActivityGeneration, type B3PrincipalId, type B3Result, type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  deriveWatchDeadlineId, mintWatchRuleId, subjectKey, SUPERVISION_RECORD_WRITER,
  ACTIVITY_DRIFT_TEMPLATE_REF,
  type InstallRunWatchersInput, type NotificationRecipient, type VersionedRef,
  type ResolvedWatcherInstall, type WatcherInstallAuthority,
  type WatchDeadline, type WatcherTemplate, type WatcherTemplateCatalogue,
  type WatchRule, type WatchSubject,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import { templateDigest } from './templates.js';
import {
  recipientKey, sameRecipient, sameVersionedRef, validateInstallAuthority,
} from './install-authority.js';

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
const installEffectKey = (input: InstallRunWatchersInput, templateRef: VersionedRef): string => [
  'b3v4:install-run-watchers', String(input.agentRunId), String(input.launchPlanId),
  `${templateRef.id}@${String(templateRef.version)}#${templateRef.digest}`,
  recipientKey(input.recipient), String(input.activityGeneration),
].join(':');

function ruleRecord(
  template: WatcherTemplate,
  plan: ResolvedWatcherInstall,
  request: InstallRunWatchersInput['requestProvenance'],
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
      requestedBy: request.requestedBy,
      requestTraceId: request.traceId,
      requestClientOpId: request.clientOpId,
    },
  };
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
  const seen = new Set<string>();
  for (const templateRef of requiredRefs(plan)) {
    if (seen.has(templateRef.id)) {
      return b3fail(b3err(
        'WatchRuleInvalid', 'watcher template ids must be unique within one install',
        { templateId: templateRef.id }, false,
      ));
    }
    seen.add(templateRef.id);
    const resolved = catalogue.resolve(templateRef);
    const valid = resolved !== null
      && sameVersionedRef(resolved.templateRef, templateRef)
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
    && sameVersionedRef(prior.installation.templateRef, template.templateRef)
    && prior.installation.launchPlanId === input.launchPlanId
    && prior.installation.activityGeneration === input.activityGeneration
    && prior.installation.requestedBy === input.requestProvenance.requestedBy
    && prior.installation.requestTraceId === input.requestProvenance.traceId
    && prior.installation.requestClientOpId === input.requestProvenance.clientOpId
    && sameRecipient(prior.recipient, input.recipient);
}

function adoptInstalled(
  existing: readonly WatchRule[],
  input: InstallRunWatchersInput,
  templates: readonly WatcherTemplate[],
): readonly WatchRule[] | null {
  const adopted: WatchRule[] = [];
  for (const template of templates) {
    const prior = matchingInstalledRule(existing, input, template);
    if (prior === undefined || !priorMatches(prior, input, template)) return null;
    adopted.push(prior);
  }
  return adopted;
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
      ruleRecord(template, plan, input.requestProvenance, subject),
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
  const templates = resolveTemplates(deps.templates, authority.value);
  if (!templates.ok) return templates;
  const authorized = validateInstallAuthority(
    context, input, authority.value, templates.value,
  );
  if (!authorized.ok) return authorized;
  const existing = await deps.store.list<WatchRule>('watchRule');
  if (!existing.ok) return existing;
  const adopted = adoptInstalled(existing.value, input, templates.value);
  if (adopted !== null) return b3ok(adopted);
  if (input.activityGeneration !== authority.value.activityGeneration) {
    return b3fail(b3err(
      'IdempotencyConflict',
      'watcher install generation is stale and no complete prior effect can be adopted',
      {
        requestedGeneration: input.activityGeneration,
        currentGeneration: authority.value.activityGeneration,
      },
      false,
    ));
  }
  const installed: WatchRule[] = [];
  for (const template of templates.value) {
    const written = await installTemplate(
      deps, context, input, authority.value, existing.value, template,
    );
    if (!written.ok) return written;
    installed.push(written.value);
  }
  return b3ok(installed);
}

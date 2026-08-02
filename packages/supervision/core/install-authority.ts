// Cross-owner install facts checked before Supervision writes a watcher.
//
// Runtime may request an install, but it cannot invent the immutable plan,
// current recipient, launch attribution, or scoped start-turn authority.
import {
  b3err, b3fail, b3ok, type B3Result, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  InstallRunWatchersInput, NotificationRecipient, ResolvedWatcherInstall,
  VersionedRef, WatcherTemplate,
} from '../contract/index.js';

export const sameVersionedRef = (left: VersionedRef, right: VersionedRef): boolean =>
  left.id === right.id && left.version === right.version && left.digest === right.digest;

export const recipientKey = (recipient: NotificationRecipient): string =>
  recipient.kind === 'agent'
    ? `agent:${String(recipient.agentId)}`
    : `human:${String(recipient.principalId)}`;

export const sameRecipient = (
  left: NotificationRecipient, right: NotificationRecipient,
): boolean => recipientKey(left) === recipientKey(right);

function installFactsMatch(
  input: InstallRunWatchersInput, plan: ResolvedWatcherInstall,
): boolean {
  return input.agentRunId === plan.agentRunId
    && input.launchPlanId === plan.launchPlanId
    && sameRecipient(input.recipient, plan.recipient)
    && input.requiredTemplateRefs.length === plan.requiredTemplateRefs.length
    && input.requiredTemplateRefs.every((templateRef, index) =>
      sameVersionedRef(templateRef, plan.requiredTemplateRefs[index]!));
}

function provenanceMatches(
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: InstallRunWatchersInput,
  plan: ResolvedWatcherInstall,
): boolean {
  return context.principal.id === 'sys_agent_runtime'
    && context.clientOpId === input.requestProvenance.clientOpId
    && context.traceId === input.requestProvenance.traceId
    && input.requestProvenance.requestedBy === plan.requestProvenance.requestedBy
    && input.requestProvenance.traceId === plan.requestProvenance.traceId;
}

function requiresStartTurn(
  templates: readonly WatcherTemplate[], plan: ResolvedWatcherInstall,
): boolean {
  return templates.some((template) => template.payload.condition.kind === 'activity-drift'
    || template.payload.deliveryBinding === 'start-turn'
    || (template.payload.deliveryBinding === 'role.parentNotificationMode-for-escalation'
      && plan.parentNotificationMode === 'start-turn'));
}

export function validateInstallAuthority(
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: InstallRunWatchersInput,
  plan: ResolvedWatcherInstall,
  templates: readonly WatcherTemplate[],
): B3Result<null> {
  if (!installFactsMatch(input, plan)) {
    return b3fail(b3err(
      'IdempotencyConflict',
      'watcher install facts do not match the authoritative launch plan and Run',
      { agentRunId: input.agentRunId, launchPlanId: input.launchPlanId },
      false,
    ));
  }
  if (!provenanceMatches(context, input, plan)) {
    return b3fail(b3err(
      'PermissionDenied',
      'watcher install provenance does not match Runtime-owned launch attribution',
      { agentRunId: input.agentRunId },
      false,
    ));
  }
  if (requiresStartTurn(templates, plan) && !plan.watchStartTurnAuthorized) {
    return b3fail(b3err(
      'PermissionDenied',
      'watcher install requires supervision:watch:start-turn pinned in the launch plan',
      { launchPlanId: input.launchPlanId },
      false,
    ));
  }
  return b3ok(null);
}

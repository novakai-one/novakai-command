// Resolve the role's watcher policy and its authority into one immutable pair.
// Keeping these together prevents a plan from pinning a watcher without also
// pinning the command scope that watcher needs.
import {
  b3fail, b3ok, type B3Result,
} from '@novakai/foundation/contract';
import type {
  AgentRoleProfile, ResolvedExecutionPolicy, ResolvedSupervisionPolicy,
  WatcherTemplateRefCatalogue,
} from '../contract/records.js';
import { SCOPE } from './context.js';
import { launchPlanInvalid } from './store.js';

export interface SupervisionPlanFacts {
  readonly policy: ResolvedSupervisionPolicy;
  readonly executionPolicy: ResolvedExecutionPolicy;
}

export function resolveSupervisionPlan(
  role: AgentRoleProfile, templates: WatcherTemplateRefCatalogue,
): B3Result<SupervisionPlanFacts> {
  const activityDriftRef = role.supervisionPolicy.activityDrift === 'required'
    ? templates.activityDriftRef() : null;
  if (role.supervisionPolicy.activityDrift === 'required' && activityDriftRef === null) {
    return b3fail(launchPlanInvalid([{
      path: 'supervisionPolicy.activityDrift',
      message: 'required activity drift has no exact template in the Agents catalogue',
    }]));
  }
  const needsStartTurn = role.supervisionPolicy.activityDrift === 'required'
    || role.supervisionPolicy.parentNotificationMode === 'start-turn'
    || role.supervisionPolicy.requiredWatcherTemplates.some(
      (templateRef) => templates.inspect(templateRef)?.requiresStartTurn === true,
    );
  return b3ok({
    policy: {
      ...role.supervisionPolicy,
      ...(activityDriftRef === null ? {} : { activityDriftTemplateRef: activityDriftRef }),
    },
    executionPolicy: {
      policyRef: role.executionPolicyRef,
      commandScopes: needsStartTurn ? [SCOPE.watchStartTurn] : [],
      filesystemScopes: [],
      networkScopes: [],
      enforcement: 'advisory',
      limitations: [
        'Novakai enforces its own capability scopes; OS and provider command '
          + 'restriction is advisory until a sandbox adapter exists',
      ],
    },
  });
}

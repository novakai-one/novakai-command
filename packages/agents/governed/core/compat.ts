import type {
  AgentRoleProfile, ResolvedLaunchPlan, RoleSupervisionPolicy,
} from '../contract/records.js';

/**
 * The `activityDrift` field arrived additively at schema v1. Historical rows
 * had no implicit watcher, so the lawful in-memory compatibility view is the
 * explicit opt-out. New writes must still carry the field and pass authority.
 */
function supervisionPolicy(
  policy: RoleSupervisionPolicy | (Omit<RoleSupervisionPolicy, 'activityDrift'> & {
    readonly activityDrift?: RoleSupervisionPolicy['activityDrift'];
  }),
): RoleSupervisionPolicy {
  return {
    ...policy,
    activityDrift: policy.activityDrift ?? 'disabled-explicitly',
  };
}

export function compatibleRole(role: AgentRoleProfile): AgentRoleProfile {
  return { ...role, supervisionPolicy: supervisionPolicy(role.supervisionPolicy) };
}

export function compatiblePlan(plan: ResolvedLaunchPlan): ResolvedLaunchPlan {
  return { ...plan, supervisionPolicy: supervisionPolicy(plan.supervisionPolicy) };
}

// Resolving a launch plan.
//
// This is the last moment before anything exists. Every refusal here costs
// nothing to undo — no Agent, no Run, no PTY, no provider process — which is
// exactly why the public proof ("forbidden role/control overrides fail
// WITHOUT spawning") is decided in this file and nowhere later.
import {
  b3fail, b3ok, mintResolvedLaunchPlanId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type FieldIssue,
  type ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';
import type { ResolveLaunchPlanInput } from '../contract/api.js';
import { readResolveLaunchPlanInput } from '../contract/validate.js';
import type {
  Agent, AgentRoleProfile, ControlReplacementPlan, ResolvedLaunchPlan,
} from '../contract/records.js';
import { fingerprint, type GovernedAgentsCore } from './context.js';
import { launchPlanInvalid, type Persisted } from './store.js';
import { requireAgent } from './agents.js';
import { getRoleProfile } from './roles.js';
import { compatiblePlan } from './compat.js';
import { resolveSupervisionPlan, type SupervisionPlanFacts } from './supervision-plan.js';

export async function resolveLaunchPlan(
  core: GovernedAgentsCore, context: CommandContext, input: ResolveLaunchPlanInput,
): Promise<B3Result<ResolvedLaunchPlan>> {
  const read = readResolveLaunchPlanInput(input);
  if (!read.ok) return read;
  const request = read.value;

  const agent = await requireAgent(core, request.agentId);
  if (!agent.ok) return agent;

  if (request.configurationMode === 'inherit-plan') {
    return inheritPlan(core, request);
  }
  if (request.configurationMode === 'signed-control-replacement') {
    return replacementPlan(core, request);
  }
  return freshPlan(core, context, request, agent.value);
}

/**
 * Inheriting means inheriting. The plan comes back byte-identical, so a
 * continuation cannot quietly become a re-configuration.
 */
async function inheritPlan(
  core: GovernedAgentsCore, request: ResolveLaunchPlanInput,
): Promise<B3Result<ResolvedLaunchPlan>> {
  if (request.inheritedPlanId === undefined) {
    return b3fail(launchPlanInvalid([
      { path: 'inheritedPlanId', message: 'is required for inherit-plan' },
    ]));
  }
  const plan = await core.store.read<ResolvedLaunchPlan>(
    'resolvedLaunchPlan', request.inheritedPlanId,
  );
  if (!plan.ok) return plan;
  if (plan.value === null) {
    return b3fail(launchPlanInvalid([
      { path: 'inheritedPlanId', message: 'names no launch plan' },
    ]));
  }
  const inherited = compatiblePlan(plan.value);
  const issues: FieldIssue[] = [];
  if (inherited.agentId !== request.agentId) {
    issues.push({ path: 'inheritedPlanId', message: 'belongs to a different Agent' });
  }
  if (inherited.workingDirectory !== request.workingDirectory) {
    issues.push({
      path: 'workingDirectory',
      message: `is not the inherited plan's directory (${inherited.workingDirectory})`,
    });
  }
  if (requestedAnyOverride(request)) {
    issues.push({
      path: 'configurationMode',
      message: 'inherit-plan cannot carry provider/model/effort overrides; use refresh-role',
    });
  }
  const supervision = supervisionIssues(inherited, request.supervised);
  issues.push(...supervision);
  if (issues.length > 0) return b3fail(launchPlanInvalid(issues));
  return b3ok(inherited);
}

/**
 * A signed replacement is the ONLY way a control that needs a new Run becomes a
 * new Run, and it is still not automatic: the caller had to ask for this plan
 * by id.
 */
async function replacementPlan(
  core: GovernedAgentsCore, request: ResolveLaunchPlanInput,
): Promise<B3Result<ResolvedLaunchPlan>> {
  if (request.replacementPlanId === undefined) {
    return b3fail(launchPlanInvalid([
      { path: 'replacementPlanId', message: 'is required for signed-control-replacement' },
    ]));
  }
  const replacement = await core.store.read<ControlReplacementPlan>(
    'controlReplacementPlan', request.replacementPlanId,
  );
  if (!replacement.ok) return replacement;
  if (replacement.value === null) {
    return b3fail(launchPlanInvalid([
      { path: 'replacementPlanId', message: 'names no replacement plan' },
    ]));
  }
  const issues: FieldIssue[] = [];
  if (replacement.value.agentId !== request.agentId) {
    issues.push({ path: 'replacementPlanId', message: 'belongs to a different Agent' });
  }
  if (replacement.value.expiresAt <= nowIsoUtc()) {
    issues.push({ path: 'replacementPlanId', message: 'has expired' });
  }
  if (replacement.value.signedDigest !== replacementDigest(replacement.value)) {
    issues.push({ path: 'replacementPlanId', message: 'does not match its signature' });
  }
  if (issues.length > 0) return b3fail(launchPlanInvalid(issues));

  const plan = await core.store.read<ResolvedLaunchPlan>(
    'resolvedLaunchPlan', replacement.value.proposedLaunchPlanId,
  );
  if (!plan.ok) return plan;
  if (plan.value === null) {
    return b3fail(launchPlanInvalid([
      { path: 'replacementPlanId', message: 'names a launch plan that no longer exists' },
    ]));
  }
  const replacementLaunch = compatiblePlan(plan.value);
  const supervision = supervisionIssues(replacementLaunch, request.supervised);
  if (supervision.length > 0) return b3fail(launchPlanInvalid(supervision));
  return b3ok(replacementLaunch);
}

async function freshPlan(
  core: GovernedAgentsCore,
  context: CommandContext,
  request: ResolveLaunchPlanInput,
  agent: Agent,
): Promise<B3Result<ResolvedLaunchPlan>> {
  const role = await getRoleProfile(core, context.principal, agent.roleProfileId);
  if (!role.ok) return role;
  if (role.value.status === 'retired') {
    return b3fail(retiredRole(role.value));
  }

  const chosen = chooseWithinPolicy(role.value, request);
  if (!chosen.ok) return chosen;
  const supervisionPlan = resolveSupervisionPlan(role.value, core.watcherTemplates);
  if (!supervisionPlan.ok) return supervisionPlan;

  const content = planContent(
    agent, role.value, request, chosen.value, supervisionPlan.value,
  );
  const supervision = supervisionIssues(content, request.supervised);
  if (supervision.length > 0) return b3fail(launchPlanInvalid(supervision));

  const record: Persisted<ResolvedLaunchPlan> = {
    kind: 'resolvedLaunchPlan',
    id: mintResolvedLaunchPlanId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    ...content,
    resolutionFingerprint: fingerprint(content),
  };
  return core.store.create<ResolvedLaunchPlan>(
    context.principal.id, record as never, context.clientOpId,
  );
}

interface ChosenLaunch {
  readonly provider: ResolvedLaunchPlan['provider'];
  readonly modelId: string;
  readonly effort: string;
}

/**
 * The whole override policy, in one place, reporting EVERY refusal at once. A
 * caller that asked for three forbidden things learns about three of them.
 */
function chooseWithinPolicy(
  role: AgentRoleProfile, request: ResolveLaunchPlanInput,
): B3Result<ChosenLaunch> {
  const issues: FieldIssue[] = [];
  const provider = request.requestedProvider ?? role.providerPolicy.defaultProvider;
  if (!role.providerPolicy.allowed.includes(provider)) {
    issues.push({
      path: 'requestedProvider',
      message: `is not permitted by role "${role.name}" (allowed: ${role.providerPolicy.allowed.join(', ')})`,
    });
  }
  const modelId = request.requestedModelId ?? role.modelPolicy.defaultModelId;
  if (!role.modelPolicy.allowedModelIds.includes(modelId)) {
    issues.push({
      path: 'requestedModelId',
      message: `is not permitted by role "${role.name}" (allowed: ${role.modelPolicy.allowedModelIds.join(', ')})`,
    });
  }
  const effort = request.requestedEffort ?? role.effortPolicy.defaultEffort;
  if (!role.effortPolicy.allowed.includes(effort)) {
    issues.push({
      path: 'requestedEffort',
      message: `is not permitted by role "${role.name}" (allowed: ${role.effortPolicy.allowed.join(', ')})`,
    });
  }
  if (issues.length > 0) return b3fail(launchPlanInvalid(issues));
  return b3ok({ provider, modelId, effort });
}

type PlanContent = Omit<
  ResolvedLaunchPlan,
  'id' | 'kind' | 'schemaVersion' | 'recordVersion' | 'createdAt' | 'permissionLevel'
  | 'createdBy' | 'lastMutation' | 'resolutionFingerprint'
>;

function planContent(
  agent: Agent,
  role: AgentRoleProfile,
  request: ResolveLaunchPlanInput,
  chosen: ChosenLaunch,
  supervision: SupervisionPlanFacts,
): PlanContent {
  return {
    agentId: agent.id,
    roleProfile: {
      id: role.id,
      version: role.recordVersion,
      digest: fingerprint({
        providerPolicy: role.providerPolicy,
        modelPolicy: role.modelPolicy,
        effortPolicy: role.effortPolicy,
        skillRefs: role.skillRefs,
        skillsConfirmationGate: role.skillsConfirmationGate,
      }),
    },
    provider: chosen.provider,
    modelId: chosen.modelId,
    effort: chosen.effort,
    workingDirectory: request.workingDirectory,
    skills: role.skillRefs,
    hooks: role.hookRefs,
    instructions: role.instructionRefs,
    skillsConfirmationGate: role.skillsConfirmationGate,
    executionPolicy: supervision.executionPolicy,
    spawnPolicy: role.spawnPolicy,
    lifecyclePolicy: role.lifecyclePolicy,
    supervisionPolicy: supervision.policy,
    budgetPolicy: role.budgetPolicy,
  };
}

/**
 * The check that must happen BEFORE effects: supervised work needs a two-turn
 * gate and a non-empty pinned skill list. A disabled gate is legal for exactly
 * one thing — interactive chat with no supervised task.
 */
function supervisionIssues(
  plan: Pick<ResolvedLaunchPlan, 'skillsConfirmationGate' | 'skills'>, supervised: boolean,
): FieldIssue[] {
  if (!supervised) return [];
  const issues: FieldIssue[] = [];
  if (plan.skillsConfirmationGate.mode !== 'required-two-turn') {
    issues.push({
      path: 'skillsConfirmationGate.mode',
      message: 'supervised work requires required-two-turn; a disabled gate is '
        + 'legal only for an interactive chat launch',
    });
  }
  if (plan.skills.length === 0) {
    issues.push({
      path: 'skills',
      message: 'supervised work requires a non-empty pinned skill list',
    });
  }
  return issues;
}

const requestedAnyOverride = (request: ResolveLaunchPlanInput): boolean =>
  request.requestedProvider !== undefined
  || request.requestedModelId !== undefined
  || request.requestedEffort !== undefined;

const retiredRole = (role: AgentRoleProfile): ReturnType<typeof launchPlanInvalid> =>
  ({
    code: 'RoleNotAllowed',
    message: `role "${role.name}" is retired and cannot be launched from`,
    details: { roleProfileId: role.id },
    retryable: false,
  });

/** The signature a replacement plan carries, so a forged one cannot be honoured. */
export function replacementDigest(
  plan: Pick<ControlReplacementPlan,
    'agentId' | 'expectedOldRunId' | 'requestedControl' | 'proposedLaunchPlanId' | 'expiresAt'>,
): string {
  return fingerprint({
    agentId: plan.agentId,
    expectedOldRunId: plan.expectedOldRunId,
    requestedControl: plan.requestedControl,
    proposedLaunchPlanId: plan.proposedLaunchPlanId,
    expiresAt: plan.expiresAt,
  });
}

export async function getLaunchPlan(
  core: GovernedAgentsCore,
  _principal: AuthenticatedPrincipal,
  launchPlanId: ResolvedLaunchPlanId,
): Promise<B3Result<ResolvedLaunchPlan>> {
  const found = await core.store.read<ResolvedLaunchPlan>('resolvedLaunchPlan', launchPlanId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(launchPlanInvalid([
      { path: 'launchPlanId', message: 'names no launch plan' },
    ]));
  }
  return b3ok(compatiblePlan(found.value));
}

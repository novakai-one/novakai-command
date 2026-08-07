// Provider controls, told honestly (DEC-B3V4-20/31, B3R-006, red gate 21).
//
// Three answers exist and all three are real: the provider did it, the provider
// can only do it by starting a new Run, or the provider cannot do it. Nothing
// here translates a request into a different effect to make an answer look
// better than it is.
import {
  b3fail, b3ok, mintControlReplacementPlanId, mintResolvedLaunchPlanId, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type IsoUtc,
} from '@novakai/foundation/contract';
import type {
  AgentControlCapability, AgentControlCapabilityReport, AgentControlOutcome,
  ApplyAgentControlInput, DiscoverAgentControlsInput,
} from '../contract/api.js';
import { readAgentControl } from '../contract/validate.js';
import type {
  AgentControl, AgentRoleProfile, ControlReplacementPlan, ProviderKind,
  ResolvedLaunchPlan,
} from '../contract/records.js';
import type {
  ProviderCapability, ProviderCapabilityReport,
} from '../contract/providers.js';
import { permissionDenied, type GovernedAgentsCore } from './context.js';
import { launchPlanInvalid, type Persisted } from './store.js';
import { getLaunchPlan, replacementDigest } from './plans.js';
import { getRoleProfile } from './roles.js';
import { requireAgent } from './agents.js';

/** How long a signed replacement plan stays honourable. */
const REPLACEMENT_TTL_MS = 10 * 60 * 1000;

export async function discoverAgentControls(
  core: GovernedAgentsCore,
  principal: AuthenticatedPrincipal,
  input: DiscoverAgentControlsInput,
): Promise<B3Result<AgentControlCapabilityReport>> {
  const plan = await getLaunchPlan(core, principal, input.launchPlanId);
  if (!plan.ok) return plan;
  const adapter = core.providers[plan.value.provider];
  const capabilities = await adapter.discoverCapabilities();
  const agent = await requireAgent(core, plan.value.agentId);
  if (!agent.ok) return agent;
  const role = await getRoleProfile(core, principal, agent.value.roleProfileId);
  if (!role.ok) return role;

  return b3ok({
    agentRunId: input.agentRunId,
    provider: plan.value.provider,
    testedProviderVersion: capabilities.testedProviderVersion,
    controls: [
      controlCapability('model', capabilities.modelChange, role.value, plan.value),
      controlCapability('effort', capabilities.effortChange, role.value, plan.value),
      controlCapability('provider-setting', capabilities.modelChange, role.value, plan.value),
    ],
  });
}

/**
 * Two independent facts, reported separately because they fail differently: can
 * the PROVIDER do this, and does the ROLE permit it. A role that forbids model
 * changes turns a `native` provider answer into `unsupported` with the reason
 * naming the policy, not the CLI.
 */
function controlCapability(
  name: AgentControl['name'],
  provider: ProviderCapability,
  role: AgentRoleProfile,
  plan: ResolvedLaunchPlan,
): AgentControlCapability {
  const allowedValues = name === 'model' ? role.modelPolicy.allowedModelIds
    : name === 'effort' ? role.effortPolicy.allowed : undefined;
  const policyForbids = name === 'model'
    && !role.modelPolicy.allowNativeChange && !role.modelPolicy.allowReplacementChange;
  if (policyForbids) {
    return {
      name,
      ...(allowedValues === undefined ? {} : { allowedValues }),
      support: 'unsupported',
      enforcement: 'enforced',
      reason: `role "${role.name}" does not permit changing ${name}`,
    };
  }
  const support = provider.support === 'native' && name === 'model'
    && !role.modelPolicy.allowNativeChange
    ? 'replacement-required' as const
    : provider.support;
  return {
    name,
    ...(allowedValues === undefined ? {} : { allowedValues }),
    support,
    // Novakai's own policy is enforced; the provider's behaviour is evidence.
    enforcement: 'enforced',
    reason: `${plan.provider}: ${provider.evidence}`,
  };
}

export async function applyAgentControl(
  core: GovernedAgentsCore, context: CommandContext, input: ApplyAgentControlInput,
): Promise<B3Result<AgentControlOutcome>> {
  const subject = await loadSubject(core, context, input);
  if (!subject.ok) return subject;
  const { control, plan, role } = subject.value;

  const adapter = core.providers[plan.provider];
  const capabilities = await adapter.discoverCapabilities();
  const capability = control.name === 'effort'
    ? capabilities.effortChange : capabilities.modelChange;

  if (capability.support === 'native' && role.modelPolicy.allowNativeChange) {
    const native = await tryNative(adapter, input, control);
    if (!native.ok) return native;
    // `null` means the adapter changed its mind at the seam: fall through to a
    // replacement rather than report an effect that did not happen.
    if (native.value !== null) return b3ok(native.value);
  }
  if (!role.modelPolicy.allowReplacementChange) {
    return b3ok({
      kind: 'unsupported',
      support: capability.support,
      reason: `role "${role.name}" does not permit a replacement Run to change ${control.name}`,
    });
  }
  return proposeReplacement(core, context, input, plan, control);
}

interface ControlSubject {
  readonly control: AgentControl;
  readonly plan: ResolvedLaunchPlan;
  readonly role: AgentRoleProfile;
}

/** Everything the decision needs, loaded and checked before any provider call. */
async function loadSubject(
  core: GovernedAgentsCore, context: CommandContext, input: ApplyAgentControlInput,
): Promise<B3Result<ControlSubject>> {
  const control = readAgentControl(input.control);
  if (!control.ok) return control;
  const plan = await getLaunchPlan(core, context.principal, input.launchPlanId);
  if (!plan.ok) return plan;
  const agent = await requireAgent(core, input.agentId);
  if (!agent.ok) return agent;
  const role = await getRoleProfile(core, context.principal, agent.value.roleProfileId);
  if (!role.ok) return role;
  const permitted = valueWithinPolicy(role.value, control.value);
  if (!permitted.ok) return permitted;
  return b3ok({ control: control.value, plan: plan.value, role: role.value });
}

async function tryNative(
  adapter: GovernedAgentsCore['providers'][ProviderKind],
  input: ApplyAgentControlInput,
  control: AgentControl,
): Promise<B3Result<AgentControlOutcome | null>> {
  const applied = await adapter.applyControl({
    providerSessionId: input.providerSessionId, control,
  });
  if (!applied.ok) return applied;
  if (applied.value.kind === 'applied-native') {
    return b3ok({ kind: 'applied-native', agentRunId: input.agentRunId, control });
  }
  if (applied.value.kind === 'unsupported') {
    return b3ok({ kind: 'unsupported', support: 'unsupported', reason: applied.value.reason });
  }
  return b3ok(null);
}

function valueWithinPolicy(
  role: AgentRoleProfile, control: AgentControl,
): B3Result<null> {
  if (control.name === 'model' && !role.modelPolicy.allowedModelIds.includes(control.value)) {
    return b3fail(launchPlanInvalid([{
      path: 'control.value',
      message: `is not a model role "${role.name}" permits`,
    }]));
  }
  if (control.name === 'effort' && !role.effortPolicy.allowed.includes(control.value)) {
    return b3fail(launchPlanInvalid([{
      path: 'control.value',
      message: `is not an effort role "${role.name}" permits`,
    }]));
  }
  return b3ok(null);
}

/**
 * A replacement is a PROPOSAL. It records a plan and signs it; it starts
 * nothing. Someone still has to call `continueAgent` with this id, which is
 * what keeps "a control never replaces a Run automatically" true.
 */
async function proposeReplacement(
  core: GovernedAgentsCore,
  context: CommandContext,
  input: ApplyAgentControlInput,
  plan: ResolvedLaunchPlan,
  control: AgentControl,
): Promise<B3Result<AgentControlOutcome>> {
  const proposed: Persisted<ResolvedLaunchPlan> = {
    ...plan,
    id: mintResolvedLaunchPlanId(),
    createdAt: nowIsoUtc(),
    createdBy: context.principal.id,
    ...(control.name === 'model' ? { modelId: control.value } : {}),
    ...(control.name === 'effort' ? { effort: control.value } : {}),
  };
  const written = await core.store.create<ResolvedLaunchPlan>(
    context.principal.id, proposed as never, context.clientOpId,
  );
  if (!written.ok) return written;

  const expiresAt = new Date(Date.now() + REPLACEMENT_TTL_MS).toISOString() as IsoUtc;
  const body = {
    agentId: input.agentId,
    expectedOldRunId: input.agentRunId,
    requestedControl: control,
    proposedLaunchPlanId: written.value.id,
    expiresAt,
  };
  const record: Persisted<ControlReplacementPlan> = {
    kind: 'controlReplacementPlan',
    id: mintControlReplacementPlanId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    ...body,
    signedDigest: replacementDigest(body),
  };
  const plan2 = await core.store.create<ControlReplacementPlan>(
    context.principal.id, record as never, context.clientOpId,
  );
  if (!plan2.ok) return plan2;
  return b3ok({ kind: 'replacement-required', plan: plan2.value });
}

export const controlDenied = (operation: string): ReturnType<typeof permissionDenied> =>
  permissionDenied(operation);

export type { ProviderCapabilityReport };

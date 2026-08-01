// Runtime validators for every governed-Agents boundary payload (§4.2 MUST).
//
// A brand is erased at runtime and a cast proves nothing, so everything that
// arrives from a socket, a CLI or a script is read here — and a payload that
// fails reports EVERY reason at once, because a caller fixing one field at a
// time is a caller we made do our job.
import {
  b3fail, b3ok, readBoundary, validationFailed,
  type B3Result, type FieldIssue, type FieldReader,
} from '@novakai/foundation/contract';
import type {
  AgentId, AgentRoleProfileId, AgentRunId, AuthorityScope,
  ControlReplacementPlanId, DelegationGrantId, HumanPrincipalId, ProviderSessionId,
  RecordVersion, ResolvedLaunchPlanId,
} from '@novakai/foundation/contract';
import type {
  AuthoriseSpawnInput, CreateAgentFromRoleInput, CreateRoleProfileInput,
  IssueDelegationGrantInput, LaunchConfigurationMode, RecordRelationshipInput,
  RegisterProviderSessionInput, ResolveLaunchPlanInput, UpdateRoleProfileInput,
} from './api.js';
import {
  AGENT_CONTROL_NAMES, LAUNCH_SURFACES, PROVIDER_KINDS,
  type AgentControl, type ProviderKind,
} from './records.js';
import {
  budgetPolicy, effortPolicy, flag, idList, lifecyclePolicy, modelPolicy,
  providerPolicy, refList, skillsGate, spawnPolicy, supervisionPolicy, textList,
  versionedRef,
} from './validate-role.js';

export const LAUNCH_CONFIGURATION_MODES: readonly LaunchConfigurationMode[] = [
  'inherit-plan', 'refresh-role', 'signed-control-replacement',
];

export function readCreateRoleProfileInput(
  candidate: unknown,
): B3Result<CreateRoleProfileInput> {
  return readBoundary(candidate, (field) => ({
    name: field.text('name'),
    description: field.optionalText('description') ?? '',
    status: field.choice('status', ['active', 'retired'] as const),
    providerPolicy: providerPolicy(field),
    modelPolicy: modelPolicy(field),
    effortPolicy: effortPolicy(field),
    skillRefs: refList(field, 'skillRefs'),
    hookRefs: refList(field, 'hookRefs'),
    instructionRefs: refList(field, 'instructionRefs'),
    skillsConfirmationGate: skillsGate(field),
    executionPolicyRef: versionedRef(field, 'executionPolicyRef'),
    spawnPolicy: spawnPolicy(field),
    lifecyclePolicy: lifecyclePolicy(field),
    supervisionPolicy: supervisionPolicy(field),
    budgetPolicy: budgetPolicy(field),
  }));
}

export function readUpdateRoleProfileInput(
  candidate: unknown,
): B3Result<UpdateRoleProfileInput> {
  const envelope = readBoundary(candidate, (field) => ({
    roleProfileId: field.id<AgentRoleProfileId>('roleProfileId', 'agentRole'),
    expectedRecordVersion: field.count('expectedRecordVersion', 1, Number.MAX_SAFE_INTEGER) as RecordVersion,
    replacement: field.given('replacement'),
  }));
  if (!envelope.ok) return envelope;
  const replacement = readCreateRoleProfileInput(envelope.value.replacement);
  if (!replacement.ok) return replacement;
  return b3ok({
    roleProfileId: envelope.value.roleProfileId,
    expectedRecordVersion: envelope.value.expectedRecordVersion,
    replacement: replacement.value,
  });
}

export function readCreateAgentFromRoleInput(
  candidate: unknown,
): B3Result<CreateAgentFromRoleInput> {
  return readBoundary(candidate, (field) => {
    const parentAgentId = field.optionalId<AgentId>('parentAgentId', 'agent', 'uuidv4');
    const creatingRunId = field.optionalId<AgentRunId>('creatingRunId', 'agentRun');
    return {
      roleProfileId: field.id<AgentRoleProfileId>('roleProfileId', 'agentRole'),
      displayName: field.text('displayName'),
      rootHumanPrincipalId: field.text('rootHumanPrincipalId') as HumanPrincipalId,
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
      ...(creatingRunId === undefined ? {} : { creatingRunId }),
    };
  });
}

export function readResolveLaunchPlanInput(
  candidate: unknown,
): B3Result<ResolveLaunchPlanInput> {
  return readBoundary(candidate, (field) => {
    const inheritedPlanId = field.optionalId<ResolvedLaunchPlanId>('inheritedPlanId', 'launchPlan');
    const replacementPlanId = field.optionalId<ControlReplacementPlanId>(
      'replacementPlanId', 'controlReplacement',
    );
    const requestedProvider = field.optionalChoice<ProviderKind>('requestedProvider', PROVIDER_KINDS);
    const requestedModelId = field.optionalText('requestedModelId');
    const requestedEffort = field.optionalText('requestedEffort');
    return {
      agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
      configurationMode: field.choice('configurationMode', LAUNCH_CONFIGURATION_MODES),
      ...(inheritedPlanId === undefined ? {} : { inheritedPlanId }),
      ...(replacementPlanId === undefined ? {} : { replacementPlanId }),
      ...(requestedProvider === undefined ? {} : { requestedProvider }),
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(requestedEffort === undefined ? {} : { requestedEffort }),
      workingDirectory: field.text('workingDirectory'),
      supervised: flag(field, 'supervised'),
    };
  });
}

export function readRecordRelationshipInput(
  candidate: unknown,
): B3Result<RecordRelationshipInput> {
  return readBoundary(candidate, (field) => ({
    rootHumanPrincipalId: field.text('rootHumanPrincipalId') as HumanPrincipalId,
    parentAgentId: field.id<AgentId>('parentAgentId', 'agent', 'uuidv4'),
    childAgentId: field.id<AgentId>('childAgentId', 'agent', 'uuidv4'),
    createdFromRunId: field.id<AgentRunId>('createdFromRunId', 'agentRun'),
  }));
}

export function readIssueDelegationGrantInput(
  candidate: unknown,
): B3Result<IssueDelegationGrantInput> {
  return readBoundary(candidate, (field) => ({
    issuerAgentRunId: field.id<AgentRunId>('issuerAgentRunId', 'agentRun'),
    subjectAgentId: field.id<AgentId>('subjectAgentId', 'agent', 'uuidv4'),
    targetAgentIds: idList<AgentId>(field, 'targetAgentIds', 'agent'),
    requestedScopes: textList(field, 'requestedScopes') as readonly AuthorityScope[],
    requestedChildRoleIds: idList<AgentRoleProfileId>(
      field, 'requestedChildRoleIds', 'agentRole',
    ),
  }));
}

export function readRegisterProviderSessionInput(
  candidate: unknown,
): B3Result<RegisterProviderSessionInput> {
  const envelope = readBoundary(candidate, (field) => {
    const providerVersion = field.optionalText('providerVersion');
    const conversation = field.given('providerConversationId');
    const resume = field.given('providerResumeHandle');
    if (conversation !== null && typeof conversation !== 'string') {
      field.reject('providerConversationId', 'must be a string or null');
    }
    if (resume !== null && typeof resume !== 'string') {
      field.reject('providerResumeHandle', 'must be a string or null');
    }
    return {
      expectedProviderSessionId: field.id<ProviderSessionId>(
        'expectedProviderSessionId', 'sess', 'uuidv4',
      ),
      agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
      provider: field.choice<ProviderKind>('provider', PROVIDER_KINDS),
      providerConversationId: (conversation ?? null) as string | null,
      providerResumeHandle: (resume ?? null) as string | null,
      ...(providerVersion === undefined ? {} : { providerVersion }),
      discovery: field.given('discovery'),
    };
  });
  if (!envelope.ok) return envelope;
  const discovery = readDiscovery(envelope.value.discovery);
  if (!discovery.ok) return discovery;
  return b3ok({ ...envelope.value, discovery: discovery.value });
}

function readDiscovery(
  candidate: unknown,
): B3Result<RegisterProviderSessionInput['discovery']> {
  const state = (candidate as { state?: unknown } | null)?.state;
  if (state === 'discovered') return b3ok({ state: 'discovered' as const });
  if (state === 'failed-before-discovery') {
    return readBoundary(candidate, (field) => ({
      state: 'failed-before-discovery' as const,
      reason: field.text('reason'),
    }));
  }
  return b3fail(validationFailed([{
    path: 'discovery.state',
    message: 'must be one of: discovered, failed-before-discovery',
  }]));
}

export function readAuthoriseSpawnInput(candidate: unknown): B3Result<AuthoriseSpawnInput> {
  return readBoundary(candidate, (field) => {
    const callerAgentRunId = field.optionalId<AgentRunId>('callerAgentRunId', 'agentRun');
    const callerAgentId = field.optionalId<AgentId>('callerAgentId', 'agent', 'uuidv4');
    return {
      roleProfileId: field.id<AgentRoleProfileId>('roleProfileId', 'agentRole'),
      ...(callerAgentRunId === undefined ? {} : { callerAgentRunId }),
      ...(callerAgentId === undefined ? {} : { callerAgentId }),
    };
  });
}

export function readAgentControl(candidate: unknown): B3Result<AgentControl> {
  return readBoundary(candidate, (field) => ({
    name: field.choice('name', AGENT_CONTROL_NAMES),
    value: field.text('value'),
  }));
}

export const launchSurfaces = LAUNCH_SURFACES;

/** Assemble a validation failure from issues a policy step found, not a reader. */
export const policyIssues = (issues: readonly FieldIssue[]): ReturnType<typeof validationFailed> =>
  validationFailed(issues);

export type { DelegationGrantId };

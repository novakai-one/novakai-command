// Runtime validators for every Run boundary payload (§4.2 MUST).
//
// A cast is erased and a brand proves nothing at runtime, so every payload that
// arrives from a socket, a CLI or a script is read here before anything acts on
// it — and it reports every problem it found, not the first.
import {
  readBoundary,
  type AgentId, type AgentRunId, type B3Result, type ControlReplacementPlanId,
  type FieldReader, type HumanPrincipalId, type RecordVersion, type RunOperationId,
  type AgentRoleProfileId,
} from '@novakai/foundation/contract';
import type {
  AdoptAgentInput, ContinueAgentInput, GetAgentRunTreeInput, InterruptAgentTurnInput,
  ListAgentRunsFilter, PrepareStopAgentTreeInput, SpawnAgentInput, StopAgentInput,
  StopAgentTreeInput,
} from './runs-api.js';
import {
  AGENT_RUN_LIFECYCLES, CONTINUATION_MODES, LAUNCH_CONFIGURATION_MODES, LAUNCH_SURFACES,
  type AgentRunLifecycle, type LaunchSurface,
} from './runs.js';

const PROVIDERS = ['claude', 'codex', 'kimi'] as const;

function flag(field: FieldReader, path: string): boolean {
  const value = field.given(path);
  if (typeof value !== 'boolean') {
    field.reject(path, 'must be true or false');
    return false;
  }
  return value;
}

export function readSpawnAgentInput(candidate: unknown): B3Result<SpawnAgentInput> {
  return readBoundary(candidate, (field) => {
    const requestedProvider = field.optionalChoice('requestedProvider', PROVIDERS);
    const requestedModelId = field.optionalText('requestedModelId');
    const requestedEffort = field.optionalText('requestedEffort');
    const columns = field.optionalCount('columns', 20, 1000);
    const rows = field.optionalCount('rows', 5, 500);
    return {
      roleProfileId: field.id<AgentRoleProfileId>('roleProfileId', 'agentRole'),
      displayName: field.text('displayName'),
      ...(requestedProvider === undefined ? {} : { requestedProvider }),
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(requestedEffort === undefined ? {} : { requestedEffort }),
      workingDirectory: field.text('workingDirectory'),
      ...readTask(field),
      ...(columns === undefined ? {} : { columns }),
      ...(rows === undefined ? {} : { rows }),
    };
  });
}

/**
 * The presence of a supervised task is what makes the two-turn gate apply, so
 * it is read as a discriminated shape rather than a loose object: a `task` with
 * a misspelled `kind` must not quietly become "no task" (§6.3).
 */
function readTask(field: FieldReader): Pick<SpawnAgentInput, 'task'> {
  const given = field.given('task');
  if (given === undefined) return {};
  const nested = field.nested('task');
  return {
    task: {
      kind: nested.choice('kind', ['supervised'] as const),
      brief: nested.text('brief'),
    },
  };
}

export function readInterruptAgentTurnInput(
  candidate: unknown,
): B3Result<InterruptAgentTurnInput> {
  return readBoundary(candidate, (field) => ({
    agentRunId: field.id<AgentRunId>('agentRunId', 'agentRun'),
    expectedRecordVersion: field.count(
      'expectedRecordVersion', 1, Number.MAX_SAFE_INTEGER,
    ) as RecordVersion,
  }));
}

export function readStopAgentInput(candidate: unknown): B3Result<StopAgentInput> {
  return readBoundary(candidate, (field) => ({
    agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
    expectedLiveRunId: field.id<AgentRunId>('expectedLiveRunId', 'agentRun'),
    // A literal, not a boolean: a stop is never a side effect of something else.
    confirmation: field.choice('confirmation', ['stop-one'] as const),
  }));
}

export function readPrepareStopAgentTreeInput(
  candidate: unknown,
): B3Result<PrepareStopAgentTreeInput> {
  return readBoundary(candidate, (field) => ({
    rootAgentId: field.id<AgentId>('rootAgentId', 'agent', 'uuidv4'),
  }));
}

export function readStopAgentTreeInput(candidate: unknown): B3Result<StopAgentTreeInput> {
  return readBoundary(candidate, (field) => ({
    rootAgentId: field.id<AgentId>('rootAgentId', 'agent', 'uuidv4'),
    confirmationToken: field.text('confirmationToken'),
    confirmation: field.choice('confirmation', ['stop-tree'] as const),
  }));
}

export function readContinueAgentInput(candidate: unknown): B3Result<ContinueAgentInput> {
  return readBoundary(candidate, (field) => {
    const replacementPlanId = field.optionalId<ControlReplacementPlanId>(
      'replacementPlanId', 'controlReplacement',
    );
    const handoverArtifactId = field.optionalText('handoverArtifactId');
    return {
      agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
      expectedOldRunId: field.id<AgentRunId>('expectedOldRunId', 'agentRun'),
      // Never defaulted: §12.2's "no automatic resume" is enforced by the
      // caller having to say which of the four it means, every time.
      mode: field.choice('mode', CONTINUATION_MODES),
      configurationMode: field.choice('configurationMode', LAUNCH_CONFIGURATION_MODES),
      ...(replacementPlanId === undefined ? {} : { replacementPlanId }),
      ...(handoverArtifactId === undefined ? {} : { handoverArtifactId }),
    };
  });
}

export function readAdoptAgentInput(candidate: unknown): B3Result<AdoptAgentInput> {
  return readBoundary(candidate, (field) => ({
    subjectAgentId: field.id<AgentId>('subjectAgentId', 'agent', 'uuidv4'),
    expectedAssignmentVersion: field.count(
      'expectedAssignmentVersion', 0, Number.MAX_SAFE_INTEGER,
    ) as RecordVersion,
    supervisor: readSupervisor(field),
  }));
}

function readSupervisor(field: FieldReader): AdoptAgentInput['supervisor'] {
  const nested = field.nested('supervisor');
  const kind = nested.choice('kind', ['agent', 'human'] as const);
  if (kind === 'agent') {
    return { kind: 'agent', agentId: nested.id<AgentId>('agentId', 'agent', 'uuidv4') };
  }
  return { kind: 'human', principalId: nested.text('principalId') as HumanPrincipalId };
}

export function readListAgentRunsFilter(candidate: unknown): B3Result<ListAgentRunsFilter> {
  return readBoundary(candidate, (field) => {
    const agentId = field.optionalId<AgentId>('agentId', 'agent', 'uuidv4');
    const launchSurface = field.optionalChoice<LaunchSurface>('launchSurface', LAUNCH_SURFACES);
    const limit = field.optionalCount('limit', 1, 10_000);
    const lifecycle = field.given('lifecycle');
    const wanted = Array.isArray(lifecycle)
      && lifecycle.every((item) => AGENT_RUN_LIFECYCLES.includes(item as AgentRunLifecycle))
      ? lifecycle as AgentRunLifecycle[] : undefined;
    if (lifecycle !== undefined && wanted === undefined) {
      field.reject('lifecycle', `must be an array of: ${AGENT_RUN_LIFECYCLES.join(', ')}`);
    }
    return {
      ...(wanted === undefined ? {} : { lifecycle: wanted }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(launchSurface === undefined ? {} : { launchSurface }),
      includeFinal: flag(field, 'includeFinal'),
      ...(limit === undefined ? {} : { limit }),
    };
  });
}

export function readGetAgentRunTreeInput(candidate: unknown): B3Result<GetAgentRunTreeInput> {
  return readBoundary(candidate, (field) => ({
    rootAgentId: field.id<AgentId>('rootAgentId', 'agent', 'uuidv4'),
    maxDepth: field.count('maxDepth', 0, 64),
  }));
}

export function readAgentRunIdInput(
  candidate: unknown,
): B3Result<{ readonly agentRunId: AgentRunId }> {
  return readBoundary(candidate, (field) => ({
    agentRunId: field.id<AgentRunId>('agentRunId', 'agentRun'),
  }));
}

export function readRunOperationIdInput(
  candidate: unknown,
): B3Result<{ readonly operationId: RunOperationId }> {
  return readBoundary(candidate, (field) => ({
    operationId: field.id<RunOperationId>('operationId', 'runOperation', 'base32sha256'),
  }));
}

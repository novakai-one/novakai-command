import { createHash } from 'node:crypto';
import {
  createObject,
  isAbsent,
  listObjects,
  type ClientOpId,
  type Page,
  type ProjectId,
  type Result,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  AddMessageToProjectInput,
  AttachArtifactToProjectInput,
  SpineSourceRef,
  SpineStep,
  SpineFailure,
  SpineWorkflow,
  SpineWorkflowId,
  SpineWorkflowState,
} from '../contract/schemas.js';
import { SpineStep as SpineStepSchema } from '../contract/schemas.js';
import type { SpineError } from '../contract/errors.js';
import type { SpineContext } from './composition.js';
import {
  effectFailpointName,
  hitFailpoint,
  journalFailpointName,
} from './failpoints.js';

const PAGE_LIMIT = 100;

function stableId(prefix: 'spineStep' | 'spineWorkflow', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function stepEffectOpId(
  originalClientOpId: ClientOpId,
  step: 1 | 2,
): string {
  return `${originalClientOpId}:step:${step}`;
}

function journalMutationOpId(
  originalClientOpId: ClientOpId,
  step: 1 | 2,
  state: 'running' | 'done' | 'failed',
): ClientOpId {
  return `${originalClientOpId}:journal:step:${step}:${state}` as ClientOpId;
}

async function appendStep(
  ctx: SpineContext,
  input: {
    workflowId: SpineWorkflowId;
    workflowType: 'addMessageToProject' | 'attachArtifactToProject';
    originalClientOpId: ClientOpId;
    projectId: ProjectId;
    sourceRef: SpineSourceRef;
    note?: string;
    state: 'accepted' | 'running' | 'done' | 'failed' | 'abandoned';
    step: 0 | 1 | 2;
    eventIndex: number;
    effectOpId?: string;
    failure?: SpineFailure;
    commandClientOpId?: string;
  },
  mutationClientOpId: ClientOpId,
): Promise<Result<SpineStep, SpineError>> {
  const before = hitFailpoint(
    ctx.configuredFailpoint,
    journalFailpointName(input.state, input.step, 'before'),
    input.workflowId,
  );
  if (before) return { ok: false, error: before };
  const fact = SpineStepSchema.parse({
    kind: 'spineStep',
    id: stableId('spineStep', mutationClientOpId),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: 'team',
    createdBy: 'derived-by-foundation',
    ...input,
  });
  const created = await createObject(
    ctx.handle,
    fact,
    mutationClientOpId,
  );
  if (!created.ok) return created;
  const parsed = SpineStepSchema.safeParse(created.value.object);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'StoredSpineStepInvalid',
        message: `stored Spine fact "${created.value.object.id}" is invalid`,
        details: {
          ref: {
            kind: 'spineStep',
            id: created.value.object.id,
          },
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.') || '(root)',
            reason: issue.message,
          })),
        },
        retryable: false,
      },
    };
  }
  const after = hitFailpoint(
    ctx.configuredFailpoint,
    journalFailpointName(input.state, input.step, 'after'),
    input.workflowId,
  );
  if (after) return { ok: false, error: after };
  return { ok: true, value: parsed.data };
}

async function readAllSteps(
  ctx: SpineContext,
): Promise<Result<SpineStep[], SpineError>> {
  const facts: SpineStep[] = [];
  let cursor: string | undefined;
  do {
    const page = await listObjects<unknown>(
      ctx.handle,
      'spineStep',
      undefined,
      { cursor, limit: PAGE_LIMIT },
    );
    if (!page.ok) return page;
    for (const stored of page.value.items) {
      const parsed = SpineStepSchema.safeParse(stored.object);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: 'StoredSpineStepInvalid',
            message: `stored Spine fact "${stored.object.id}" is invalid`,
            details: {
              ref: {
                kind: 'spineStep',
                id: stored.object.id,
              },
              issues: parsed.error.issues.map((issue) => ({
                field: issue.path.join('.') || '(root)',
                reason: issue.message,
              })),
            },
            retryable: false,
          },
        };
      }
      facts.push(parsed.data);
    }
    cursor = page.value.nextCursor;
  } while (cursor !== undefined);
  return { ok: true, value: facts };
}

function foldWorkflow(facts: SpineStep[]): SpineWorkflow {
  const ordered = [...facts].sort((left, right) =>
    left.eventIndex - right.eventIndex);
  const accepted = ordered.find((fact) => fact.state === 'accepted');
  if (!accepted) {
    throw new Error('foldWorkflow requires an accepted fact');
  }
  const originalClientOpId = accepted.originalClientOpId as ClientOpId;
  const steps: SpineWorkflow['steps'] = [
    {
      number: 1,
      effectOpId: stepEffectOpId(originalClientOpId, 1),
      state: 'pending',
    },
    {
      number: 2,
      effectOpId: stepEffectOpId(originalClientOpId, 2),
      state: 'pending',
    },
  ];
  let state: SpineWorkflowState = 'accepted';
  let failure: SpineFailure | undefined;
  for (const fact of ordered) {
    if (fact.step === 1 || fact.step === 2) {
      const step = steps[fact.step - 1];
      if (step && (
        fact.state === 'running'
        || fact.state === 'done'
        || fact.state === 'failed'
      )) {
        step.state = fact.state;
      }
    }
    if (fact.state === 'running') state = 'running';
    if (fact.state === 'done') {
      state = fact.step === 2 ? 'done' : 'running';
    }
    if (fact.state === 'failed' || fact.state === 'abandoned') {
      state = fact.state;
    }
    if (fact.failure) failure = fact.failure;
  }
  const next = steps.find((step) => step.state !== 'done')?.number ?? null;
  return {
    workflowId: accepted.workflowId as SpineWorkflowId,
    workflowType: accepted.workflowType,
    originalClientOpId,
    projectId: accepted.projectId as ProjectId,
    sourceRef: accepted.sourceRef,
    ...(accepted.note === undefined ? {} : { note: accepted.note }),
    state,
    acceptedAt: accepted.createdAt,
    steps,
    ...(failure === undefined ? {} : { failure }),
    nextStep: state === 'done' || state === 'failed' || state === 'abandoned'
      ? null
      : next,
    resumable: state === 'accepted' || state === 'running',
  };
}

export async function getSpineWorkflows(
  ctx: SpineContext,
): Promise<Result<Page<SpineWorkflow>, SpineError>> {
  const read = await readAllSteps(ctx);
  if (!read.ok) return read;
  const grouped = new Map<string, SpineStep[]>();
  for (const fact of read.value) {
    const group = grouped.get(fact.workflowId) ?? [];
    group.push(fact);
    grouped.set(fact.workflowId, group);
  }
  for (const [workflowId, facts] of grouped) {
    const accepted = facts.filter((fact) => fact.state === 'accepted');
    if (accepted.length !== 1) {
      return {
        ok: false,
        error: {
          code: 'SpineJournalCorrupt',
          message: `workflow "${workflowId}" has ${accepted.length} accepted facts`,
          details: {
            workflowId,
            reason: accepted.length === 0
              ? 'missing accepted fact'
              : 'multiple accepted facts',
            factIds: facts.map((fact) => fact.id),
          },
          retryable: false,
        },
      };
    }
    const authority = accepted[0]!;
    const mismatched = facts.filter((fact) =>
      fact.workflowType !== authority.workflowType
      || fact.originalClientOpId !== authority.originalClientOpId
      || fact.projectId !== authority.projectId
      || fact.sourceRef.kind !== authority.sourceRef.kind
      || fact.sourceRef.id !== authority.sourceRef.id
      || fact.note !== authority.note);
    if (mismatched.length > 0) {
      return {
        ok: false,
        error: {
          code: 'SpineJournalCorrupt',
          message: `workflow "${workflowId}" carries inconsistent immutable inputs`,
          details: {
            workflowId,
            reason: 'immutable workflow inputs differ across facts',
            factIds: mismatched.map((fact) => fact.id),
          },
          retryable: false,
        },
      };
    }
  }
  const items = [...grouped.values()]
    .map(foldWorkflow)
    .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
  return { ok: true, value: { items } };
}

export async function scanWorkflows(
  ctx: SpineContext,
): Promise<Result<Page<SpineWorkflow>, SpineError>> {
  const workflows = await getSpineWorkflows(ctx);
  if (!workflows.ok) return workflows;
  return {
    ok: true,
    value: {
      items: workflows.value.items.filter((workflow) => workflow.resumable),
    },
  };
}

async function existingWorkflow(
  ctx: SpineContext,
  expected: {
    workflowType: SpineWorkflow['workflowType'];
    originalClientOpId: ClientOpId;
    projectId: ProjectId;
    sourceRef: SpineSourceRef;
    note?: string;
  },
): Promise<Result<SpineWorkflow | null, SpineError>> {
  const workflows = await getSpineWorkflows(ctx);
  if (!workflows.ok) return workflows;
  const existing = workflows.value.items.find(
    (workflow) =>
      workflow.originalClientOpId === expected.originalClientOpId,
  );
  if (!existing) return { ok: true, value: null };
  const differingFields: string[] = [];
  if (existing.workflowType !== expected.workflowType) {
    differingFields.push('workflowType');
  }
  if (existing.projectId !== expected.projectId) {
    differingFields.push('projectId');
  }
  if (
    existing.sourceRef.kind !== expected.sourceRef.kind
    || existing.sourceRef.id !== expected.sourceRef.id
  ) {
    differingFields.push('sourceRef');
  }
  if (existing.note !== expected.note) differingFields.push('note');
  if (differingFields.length > 0) {
    return {
      ok: false,
      error: {
        code: 'SpineIdempotencyConflict',
        message: `clientOpId "${expected.originalClientOpId}" already names a different workflow`,
        details: {
          clientOpId: expected.originalClientOpId,
          workflowId: existing.workflowId,
          differingFields,
        },
        retryable: false,
      },
    };
  }
  return { ok: true, value: existing };
}

async function workflowById(
  ctx: SpineContext,
  workflowId: SpineWorkflowId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const workflows = await getSpineWorkflows(ctx);
  if (!workflows.ok) return workflows;
  const workflow = workflows.value.items.find(
    (candidate) => candidate.workflowId === workflowId,
  );
  if (!workflow) {
    return {
      ok: false,
      error: {
        code: 'SpineWorkflowNotFound',
        message: `Spine workflow "${workflowId}" does not exist`,
        details: { workflowId },
        retryable: false,
      },
    };
  }
  return { ok: true, value: workflow };
}

function workflowFactInput(
  workflow: SpineWorkflow,
  input: {
    state: 'running' | 'done' | 'failed';
    step: 1 | 2;
    eventIndex: number;
    failure?: SpineFailure;
    commandClientOpId?: ClientOpId;
  },
) {
  return {
    workflowId: workflow.workflowId,
    workflowType: workflow.workflowType,
    originalClientOpId: workflow.originalClientOpId,
    projectId: workflow.projectId,
    sourceRef: workflow.sourceRef,
    ...(workflow.note === undefined ? {} : { note: workflow.note }),
    ...input,
    effectOpId: stepEffectOpId(workflow.originalClientOpId, input.step),
  };
}

async function runStepOne(
  ctx: SpineContext,
  workflow: SpineWorkflow,
): Promise<Result<null, SpineError>> {
  const before = hitFailpoint(
    ctx.configuredFailpoint,
    effectFailpointName(1, 'before'),
    workflow.workflowId,
  );
  if (before) return { ok: false, error: before };

  let outcome: Result<null, SpineError>;
  if (workflow.sourceRef.kind === 'message') {
    const message = await ctx.messaging.getDelivery({
      messageId: workflow.sourceRef.id,
    });
    if (message.kind === 'error') {
      outcome = message.error.name === 'UnknownMessage'
        ? {
            ok: false,
            error: {
              code: 'SpineSourceMissing',
              message: `Message "${workflow.sourceRef.id}" does not exist`,
              details: { sourceRef: workflow.sourceRef },
              retryable: false,
            },
          }
        : {
            ok: false,
            error: {
              code: 'SpineDependencyFailed',
              message: `Messaging getDelivery failed: ${message.error.message}`,
              details: {
                dependency: 'messaging',
                operation: 'getDelivery',
                cause: message.error.name,
              },
              retryable: message.error.retryable,
            },
          };
    } else {
      outcome = { ok: true, value: null };
    }
  } else {
    const artifact = await ctx.artifacts.getArtifactMeta(
      workflow.sourceRef.id as never,
    );
    if (!artifact.ok) {
      outcome = {
        ok: false,
        error: {
          code: 'SpineDependencyFailed',
          message: `Artifacts getArtifactMeta failed: ${artifact.error.message}`,
          details: {
            dependency: 'artifacts',
            operation: 'getArtifactMeta',
            cause: artifact.error.code,
          },
          retryable: artifact.error.retryable,
        },
      };
    } else if (isAbsent(artifact.value)) {
      outcome = {
        ok: false,
        error: {
          code: 'SpineSourceMissing',
          message: `Artifact "${workflow.sourceRef.id}" does not exist`,
          details: { sourceRef: workflow.sourceRef },
          retryable: false,
        },
      };
    } else {
      outcome = { ok: true, value: null };
    }
  }

  const after = hitFailpoint(
    ctx.configuredFailpoint,
    effectFailpointName(1, 'after'),
    workflow.workflowId,
  );
  return after ? { ok: false, error: after } : outcome;
}

async function runStepTwo(
  ctx: SpineContext,
  workflow: SpineWorkflow,
): Promise<Result<null, SpineError>> {
  const before = hitFailpoint(
    ctx.configuredFailpoint,
    effectFailpointName(2, 'before'),
    workflow.workflowId,
  );
  if (before) return { ok: false, error: before };

  const attached = await ctx.projects.attach(
    workflow.projectId,
    {
      itemRef: workflow.sourceRef,
      ...(workflow.note === undefined ? {} : { note: workflow.note }),
    },
    stepEffectOpId(workflow.originalClientOpId, 2) as ClientOpId,
  );
  const outcome: Result<null, SpineError> = attached.ok
    ? { ok: true, value: null }
    : {
        ok: false,
        error: {
          code: 'SpineDependencyFailed',
          message: `Projects attach failed: ${attached.error.message}`,
          details: {
            dependency: 'projects',
            operation: 'attach',
            cause: attached.error.code,
          },
          retryable: attached.error.retryable,
        },
      };

  const after = hitFailpoint(
    ctx.configuredFailpoint,
    effectFailpointName(2, 'after'),
    workflow.workflowId,
  );
  return after ? { ok: false, error: after } : outcome;
}

async function appendFailed(
  ctx: SpineContext,
  workflow: SpineWorkflow,
  step: 1 | 2,
  error: SpineError,
): Promise<Result<never, SpineError>> {
  const failure: SpineFailure = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
  const failed = await appendStep(
    ctx,
    workflowFactInput(workflow, {
      state: 'failed',
      step,
      eventIndex: step === 1 ? 2 : 4,
      failure,
    }),
    journalMutationOpId(workflow.originalClientOpId, step, 'failed'),
  );
  return failed.ok ? { ok: false, error } : failed;
}

async function resumeWorkflow(
  ctx: SpineContext,
  workflow: SpineWorkflow,
): Promise<Result<SpineWorkflow, SpineError>> {
  if (workflow.steps[0].state !== 'done') {
    const running = await appendStep(
      ctx,
      workflowFactInput(workflow, {
        state: 'running',
        step: 1,
        eventIndex: 1,
      }),
      journalMutationOpId(workflow.originalClientOpId, 1, 'running'),
    );
    if (!running.ok) return running;
    const effect = await runStepOne(ctx, workflow);
    if (!effect.ok) {
      if (effect.error.code === 'SpineFailpoint') return effect;
      return appendFailed(ctx, workflow, 1, effect.error);
    }
    const done = await appendStep(
      ctx,
      workflowFactInput(workflow, {
        state: 'done',
        step: 1,
        eventIndex: 2,
      }),
      journalMutationOpId(workflow.originalClientOpId, 1, 'done'),
    );
    if (!done.ok) return done;
  }

  if (workflow.steps[1].state !== 'done') {
    const running = await appendStep(
      ctx,
      workflowFactInput(workflow, {
        state: 'running',
        step: 2,
        eventIndex: 3,
      }),
      journalMutationOpId(workflow.originalClientOpId, 2, 'running'),
    );
    if (!running.ok) return running;
    const effect = await runStepTwo(ctx, workflow);
    if (!effect.ok) {
      if (effect.error.code === 'SpineFailpoint') return effect;
      return appendFailed(ctx, workflow, 2, effect.error);
    }
    const done = await appendStep(
      ctx,
      workflowFactInput(workflow, {
        state: 'done',
        step: 2,
        eventIndex: 4,
      }),
      journalMutationOpId(workflow.originalClientOpId, 2, 'done'),
    );
    if (!done.ok) return done;
  }
  return workflowById(ctx, workflow.workflowId);
}

export async function addMessageToProject(
  ctx: SpineContext,
  input: AddMessageToProjectInput,
  originalClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const workflowId = stableId(
    'spineWorkflow',
    originalClientOpId,
  ) as SpineWorkflowId;
  const sourceRef: SpineSourceRef = {
    kind: 'message',
    id: input.messageId,
  };
  const common = {
    workflowId,
    workflowType: 'addMessageToProject' as const,
    originalClientOpId,
    projectId: input.projectId,
    sourceRef,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  const prior = await existingWorkflow(ctx, common);
  if (!prior.ok) return prior;
  if (prior.value) return { ok: true, value: prior.value };

  const accepted = await appendStep(ctx, {
    ...common,
    state: 'accepted',
    step: 0,
    eventIndex: 0,
  }, originalClientOpId);
  if (!accepted.ok) return accepted;
  const workflow = await workflowById(ctx, workflowId);
  return workflow.ok ? resumeWorkflow(ctx, workflow.value) : workflow;
}

export async function attachArtifactToProject(
  ctx: SpineContext,
  input: AttachArtifactToProjectInput,
  originalClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const workflowId = stableId(
    'spineWorkflow',
    originalClientOpId,
  ) as SpineWorkflowId;
  const sourceRef: SpineSourceRef = {
    kind: 'artifact',
    id: input.artifactId,
  };
  const common = {
    workflowId,
    workflowType: 'attachArtifactToProject' as const,
    originalClientOpId,
    projectId: input.projectId,
    sourceRef,
    ...(input.note === undefined ? {} : { note: input.note }),
  };
  const prior = await existingWorkflow(ctx, common);
  if (!prior.ok) return prior;
  if (prior.value) return { ok: true, value: prior.value };

  const accepted = await appendStep(ctx, {
    ...common,
    state: 'accepted',
    step: 0,
    eventIndex: 0,
  }, originalClientOpId);
  if (!accepted.ok) return accepted;
  const workflow = await workflowById(ctx, workflowId);
  return workflow.ok ? resumeWorkflow(ctx, workflow.value) : workflow;
}

export async function continueWorkflow(
  ctx: SpineContext,
  workflowId: SpineWorkflowId,
  callerClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  if (
    typeof callerClientOpId !== 'string'
    || callerClientOpId.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: 'InvalidEnvelope',
        message: 'continueWorkflow requires clientOpId',
        details: {
          missingFields: ['clientOpId'],
          invalidFields: [],
        },
        retryable: false,
      },
    };
  }
  const facts = await readAllSteps(ctx);
  if (!facts.ok) return facts;
  const priorCommand = facts.value.find(
    (fact) =>
      fact.commandClientOpId === callerClientOpId
      || fact.originalClientOpId === callerClientOpId,
  );
  if (priorCommand) {
    if (priorCommand.workflowId !== workflowId) {
      return {
        ok: false,
        error: {
          code: 'SpineIdempotencyConflict',
          message: `clientOpId "${callerClientOpId}" already names a different workflow command`,
          details: {
            clientOpId: callerClientOpId,
            workflowId: priorCommand.workflowId,
            differingFields: ['workflowId'],
          },
          retryable: false,
        },
      };
    }
    const priorWorkflow = await workflowById(ctx, workflowId);
    if (!priorWorkflow.ok) return priorWorkflow;
    return priorWorkflow.value.resumable
      ? resumeWorkflow(ctx, priorWorkflow.value)
      : priorWorkflow;
  }
  const found = await workflowById(ctx, workflowId);
  if (!found.ok) return found;
  if (
    found.value.state === 'done'
    || found.value.state === 'failed'
    || found.value.state === 'abandoned'
  ) {
    return {
      ok: false,
      error: {
        code: 'SpineWorkflowNotContinuable',
        message: `workflow "${workflowId}" is ${found.value.state}`,
        details: {
          workflowId,
          state: found.value.state,
        },
        retryable: false,
      },
    };
  }
  const nextStep = found.value.nextStep;
  if (nextStep === null) return found;
  // R3-10: continuation acceptance is its own immutable running fact under
  // the caller id. Dependency effects retain the original workflow ids for
  // crash-safe replay; their journal transitions use deterministic suffixes.
  const commandAccepted = await appendStep(
    ctx,
    workflowFactInput(found.value, {
      state: 'running',
      step: nextStep,
      eventIndex: nextStep === 1 ? 1 : 3,
      commandClientOpId: callerClientOpId,
    }),
    callerClientOpId,
  );
  if (!commandAccepted.ok) return commandAccepted;
  return resumeWorkflow(ctx, found.value);
}

export async function abandonWorkflow(
  ctx: SpineContext,
  workflowId: SpineWorkflowId,
  callerClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  if (
    typeof callerClientOpId !== 'string'
    || callerClientOpId.length === 0
  ) {
    return {
      ok: false,
      error: {
        code: 'InvalidEnvelope',
        message: 'abandonWorkflow requires clientOpId',
        details: {
          missingFields: ['clientOpId'],
          invalidFields: [],
        },
        retryable: false,
      },
    };
  }
  const facts = await readAllSteps(ctx);
  if (!facts.ok) return facts;
  const priorCommand = facts.value.find(
    (fact) =>
      fact.commandClientOpId === callerClientOpId
      || fact.originalClientOpId === callerClientOpId,
  );
  if (priorCommand) {
    if (priorCommand.workflowId !== workflowId) {
      return {
        ok: false,
        error: {
          code: 'SpineIdempotencyConflict',
          message: `clientOpId "${callerClientOpId}" already names a different workflow command`,
          details: {
            clientOpId: callerClientOpId,
            workflowId: priorCommand.workflowId,
            differingFields: ['workflowId'],
          },
          retryable: false,
        },
      };
    }
    return workflowById(ctx, workflowId);
  }
  const found = await workflowById(ctx, workflowId);
  if (!found.ok) return found;
  if (
    found.value.state === 'done'
    || found.value.state === 'failed'
    || found.value.state === 'abandoned'
  ) {
    return {
      ok: false,
      error: {
        code: 'SpineWorkflowNotAbandonable',
        message: `workflow "${workflowId}" is ${found.value.state}`,
        details: {
          workflowId,
          state: found.value.state,
        },
        retryable: false,
      },
    };
  }
  const abandoned = await appendStep(ctx, {
    workflowId: found.value.workflowId,
    workflowType: found.value.workflowType,
    originalClientOpId: found.value.originalClientOpId,
    projectId: found.value.projectId,
    sourceRef: found.value.sourceRef,
    ...(found.value.note === undefined ? {} : { note: found.value.note }),
    state: 'abandoned',
    step: found.value.nextStep ?? 0,
    eventIndex: 5,
    commandClientOpId: callerClientOpId,
  }, callerClientOpId);
  if (!abandoned.ok) return abandoned;
  return workflowById(ctx, workflowId);
}

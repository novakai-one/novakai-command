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
    state: 'accepted' | 'running' | 'done' | 'failed';
    step: 0 | 1 | 2;
    eventIndex: number;
    effectOpId?: string;
    failure?: SpineFailure;
  },
  mutationClientOpId: ClientOpId,
): Promise<Result<SpineStep, SpineError>> {
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
  const items = [...grouped.values()]
    .map(foldWorkflow)
    .sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt));
  return { ok: true, value: { items } };
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

  const accepted = await appendStep(ctx, {
    ...common,
    state: 'accepted',
    step: 0,
    eventIndex: 0,
  }, originalClientOpId);
  if (!accepted.ok) return accepted;

  const runningQuery = await appendStep(ctx, {
    ...common,
    state: 'running',
    step: 1,
    eventIndex: 1,
    effectOpId: stepEffectOpId(originalClientOpId, 1),
  }, journalMutationOpId(originalClientOpId, 1, 'running'));
  if (!runningQuery.ok) return runningQuery;

  const message = await ctx.messaging.getDelivery({
    messageId: input.messageId,
  });
  if (message.kind === 'error') {
    const failure = message.error.name === 'UnknownMessage'
      ? {
          code: 'SpineSourceMissing',
          message: `Message "${input.messageId}" does not exist`,
          retryable: false,
        }
      : {
          code: 'SpineDependencyFailed',
          message: `Messaging getDelivery failed: ${message.error.message}`,
          retryable: message.error.retryable,
        };
    const failed = await appendStep(ctx, {
      ...common,
      state: 'failed',
      step: 1,
      eventIndex: 2,
      effectOpId: stepEffectOpId(originalClientOpId, 1),
      failure,
    }, journalMutationOpId(originalClientOpId, 1, 'failed'));
    if (!failed.ok) return failed;
    if (message.error.name === 'UnknownMessage') {
      return {
        ok: false,
        error: {
          code: 'SpineSourceMissing',
          message: failure.message,
          details: { sourceRef },
          retryable: false,
        },
      };
    }
    return {
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
  }

  const queryDone = await appendStep(ctx, {
    ...common,
    state: 'done',
    step: 1,
    eventIndex: 2,
    effectOpId: stepEffectOpId(originalClientOpId, 1),
  }, journalMutationOpId(originalClientOpId, 1, 'done'));
  if (!queryDone.ok) return queryDone;

  const runningAttach = await appendStep(ctx, {
    ...common,
    state: 'running',
    step: 2,
    eventIndex: 3,
    effectOpId: stepEffectOpId(originalClientOpId, 2),
  }, journalMutationOpId(originalClientOpId, 2, 'running'));
  if (!runningAttach.ok) return runningAttach;

  const attached = await ctx.projects.attach(
    input.projectId,
    {
      itemRef: sourceRef,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    stepEffectOpId(originalClientOpId, 2) as ClientOpId,
  );
  if (!attached.ok) return {
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

  const attachDone = await appendStep(ctx, {
    ...common,
    state: 'done',
    step: 2,
    eventIndex: 4,
    effectOpId: stepEffectOpId(originalClientOpId, 2),
  }, journalMutationOpId(originalClientOpId, 2, 'done'));
  if (!attachDone.ok) return attachDone;

  const workflows = await getSpineWorkflows(ctx);
  if (!workflows.ok) return workflows;
  const workflow = workflows.value.items.find(
    (candidate) => candidate.workflowId === workflowId,
  );
  if (!workflow) {
    throw new Error(`workflow ${workflowId} disappeared after durable append`);
  }
  return { ok: true, value: workflow };
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

  const accepted = await appendStep(ctx, {
    ...common,
    state: 'accepted',
    step: 0,
    eventIndex: 0,
  }, originalClientOpId);
  if (!accepted.ok) return accepted;

  const runningQuery = await appendStep(ctx, {
    ...common,
    state: 'running',
    step: 1,
    eventIndex: 1,
    effectOpId: stepEffectOpId(originalClientOpId, 1),
  }, journalMutationOpId(originalClientOpId, 1, 'running'));
  if (!runningQuery.ok) return runningQuery;

  const artifact = await ctx.artifacts.getArtifactMeta(input.artifactId);
  if (!artifact.ok) {
    return {
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
  }
  if (isAbsent(artifact.value)) {
    const failure = {
      code: 'SpineSourceMissing',
      message: `Artifact "${input.artifactId}" does not exist`,
      retryable: false,
    };
    const failed = await appendStep(ctx, {
      ...common,
      state: 'failed',
      step: 1,
      eventIndex: 2,
      effectOpId: stepEffectOpId(originalClientOpId, 1),
      failure,
    }, journalMutationOpId(originalClientOpId, 1, 'failed'));
    if (!failed.ok) return failed;
    return {
      ok: false,
      error: {
        code: 'SpineSourceMissing',
        message: failure.message,
        details: { sourceRef },
        retryable: false,
      },
    };
  }

  const queryDone = await appendStep(ctx, {
    ...common,
    state: 'done',
    step: 1,
    eventIndex: 2,
    effectOpId: stepEffectOpId(originalClientOpId, 1),
  }, journalMutationOpId(originalClientOpId, 1, 'done'));
  if (!queryDone.ok) return queryDone;

  const runningAttach = await appendStep(ctx, {
    ...common,
    state: 'running',
    step: 2,
    eventIndex: 3,
    effectOpId: stepEffectOpId(originalClientOpId, 2),
  }, journalMutationOpId(originalClientOpId, 2, 'running'));
  if (!runningAttach.ok) return runningAttach;

  const attached = await ctx.projects.attach(
    input.projectId,
    {
      itemRef: sourceRef,
      ...(input.note === undefined ? {} : { note: input.note }),
    },
    stepEffectOpId(originalClientOpId, 2) as ClientOpId,
  );
  if (!attached.ok) {
    return {
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
  }

  const attachDone = await appendStep(ctx, {
    ...common,
    state: 'done',
    step: 2,
    eventIndex: 4,
    effectOpId: stepEffectOpId(originalClientOpId, 2),
  }, journalMutationOpId(originalClientOpId, 2, 'done'));
  if (!attachDone.ok) return attachDone;

  const workflows = await getSpineWorkflows(ctx);
  if (!workflows.ok) return workflows;
  const workflow = workflows.value.items.find(
    (candidate) => candidate.workflowId === workflowId,
  );
  if (!workflow) {
    throw new Error(`workflow ${workflowId} disappeared after durable append`);
  }
  return { ok: true, value: workflow };
}

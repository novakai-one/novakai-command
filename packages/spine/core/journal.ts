import { createHash } from 'node:crypto';
import {
  createObject,
  listObjects,
  type ClientOpId,
  type Page,
  type ProjectId,
  type Result,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  SpineFailure,
  SpineSourceRef,
  SpineStep,
  SpineWorkflow,
  SpineWorkflowId,
  SpineWorkflowState,
} from '../contract/schemas.js';
import { SpineStep as SpineStepSchema } from '../contract/schemas.js';
import type { SpineError } from '../contract/errors.js';
import type { SpineContext } from './ports.js';
import {
  hitFailpoint,
  journalFailpointName,
} from './failpoints.js';

const PAGE_LIMIT = 100;

interface AppendStepInput {
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
}

function stableId(prefix: 'spineStep' | 'spineWorkflow', value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** Deterministic workflow identity derived from the acceptance operation. */
export function workflowIdFor(clientOpId: ClientOpId): SpineWorkflowId {
  return stableId('spineWorkflow', clientOpId) as SpineWorkflowId;
}

/** Correlation identity carried by journal facts and dependency effects. */
export function stepEffectOpId(
  originalClientOpId: ClientOpId,
  step: 1 | 2,
): string {
  return `${originalClientOpId}:step:${step}`;
}

/** Mutation identity for a journal fact; deliberately not an effect ID. */
export function journalMutationOpId(
  originalClientOpId: ClientOpId,
  step: 1 | 2,
  state: 'running' | 'done' | 'failed',
): ClientOpId {
  return `${originalClientOpId}:journal:step:${step}:${state}` as ClientOpId;
}

export async function appendStep(
  ctx: SpineContext,
  input: AppendStepInput,
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

export async function readAllSteps(
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

export async function existingWorkflow(
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

export async function workflowById(
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

export function workflowFactInput(
  workflow: SpineWorkflow,
  input: {
    state: 'running' | 'done' | 'failed';
    step: 1 | 2;
    eventIndex: number;
    failure?: SpineFailure;
    commandClientOpId?: ClientOpId;
  },
): AppendStepInput {
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

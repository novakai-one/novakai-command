import {
  type ClientOpId,
  type ProjectId,
  type Result,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  AddMessageToProjectInput,
  AttachArtifactToProjectInput,
  SpineSourceRef,
  SpineStep,
  SpineWorkflow,
  SpineWorkflowId,
} from '../contract/schemas.js';
import {
  AddMessageToProjectInput as AddMessageToProjectInputSchema,
  AttachArtifactToProjectInput as AttachArtifactToProjectInputSchema,
} from '../contract/schemas.js';
import type { SpineError } from '../contract/errors.js';
import type { SpineContext } from './ports.js';
import { resumeWorkflow } from './execution.js';
import {
  appendStep,
  existingWorkflow,
  getSpineWorkflows,
  readAllSteps,
  scanWorkflows,
  workflowById,
  workflowFactInput,
  workflowIdFor,
} from './journal.js';

export {
  getSpineWorkflows,
  scanWorkflows,
};

function invalidWorkflowInput(
  issues: ReadonlyArray<{
    path: Array<string | number>;
    message: string;
  }>,
): Result<never, SpineError> {
  return {
    ok: false,
    error: {
      code: 'InvalidEnvelope',
      message: 'Spine workflow input is invalid',
      details: {
        missingFields: [],
        invalidFields: issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          reason: issue.message,
        })),
      },
      retryable: false,
    },
  };
}

function requireClientOpId(
  clientOpId: ClientOpId,
): Result<ClientOpId, SpineError> {
  if (typeof clientOpId === 'string' && clientOpId.length > 0) {
    return { ok: true, value: clientOpId };
  }
  return {
    ok: false,
    error: {
      code: 'InvalidEnvelope',
      message: 'Spine workflow mutation requires clientOpId',
      details: {
        missingFields: ['clientOpId'],
        invalidFields: [],
      },
      retryable: false,
    },
  };
}

interface WorkflowStart {
  workflowType: SpineWorkflow['workflowType'];
  projectId: ProjectId;
  sourceRef: SpineSourceRef;
  note?: string;
}

async function startWorkflow(
  ctx: SpineContext,
  input: WorkflowStart,
  originalClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const workflowId = workflowIdFor(originalClientOpId);
  const common = {
    workflowId,
    originalClientOpId,
    ...input,
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

export async function addMessageToProject(
  ctx: SpineContext,
  input: AddMessageToProjectInput,
  originalClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const operationId = requireClientOpId(originalClientOpId);
  if (!operationId.ok) return operationId;
  const parsedInput = AddMessageToProjectInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidWorkflowInput(parsedInput.error.issues);
  }
  const validInput = parsedInput.data as AddMessageToProjectInput;
  return startWorkflow(ctx, {
    workflowType: 'addMessageToProject',
    projectId: validInput.projectId,
    sourceRef: {
      kind: 'message',
      id: validInput.messageId,
    },
    ...(validInput.note === undefined ? {} : { note: validInput.note }),
  }, operationId.value);
}

export async function attachArtifactToProject(
  ctx: SpineContext,
  input: AttachArtifactToProjectInput,
  originalClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const operationId = requireClientOpId(originalClientOpId);
  if (!operationId.ok) return operationId;
  const parsedInput = AttachArtifactToProjectInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return invalidWorkflowInput(parsedInput.error.issues);
  }
  const validInput = parsedInput.data as AttachArtifactToProjectInput;
  return startWorkflow(ctx, {
    workflowType: 'attachArtifactToProject',
    projectId: validInput.projectId,
    sourceRef: {
      kind: 'artifact',
      id: validInput.artifactId,
    },
    ...(validInput.note === undefined ? {} : { note: validInput.note }),
  }, operationId.value);
}

function findPriorCommand(
  facts: SpineStep[],
  clientOpId: ClientOpId,
): SpineStep | undefined {
  return facts.find(
    (fact) =>
      fact.commandClientOpId === clientOpId
      || fact.originalClientOpId === clientOpId,
  );
}

function commandConflict(
  clientOpId: ClientOpId,
  prior: SpineStep,
): Result<never, SpineError> {
  return {
    ok: false,
    error: {
      code: 'SpineIdempotencyConflict',
      message: `clientOpId "${clientOpId}" already names a different workflow command`,
      details: {
        clientOpId,
        workflowId: prior.workflowId,
        differingFields: ['workflowId'],
      },
      retryable: false,
    },
  };
}

export async function continueWorkflow(
  ctx: SpineContext,
  workflowId: SpineWorkflowId,
  callerClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const operationId = requireClientOpId(callerClientOpId);
  if (!operationId.ok) return operationId;
  const facts = await readAllSteps(ctx);
  if (!facts.ok) return facts;
  const priorCommand = findPriorCommand(facts.value, operationId.value);
  if (priorCommand) {
    if (priorCommand.workflowId !== workflowId) {
      return commandConflict(operationId.value, priorCommand);
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
  // Command acceptance is a journal mutation under the caller ID. Effects
  // keep the original workflow correlation IDs for crash-safe replay.
  const commandAccepted = await appendStep(
    ctx,
    workflowFactInput(found.value, {
      state: 'running',
      step: nextStep,
      eventIndex: nextStep === 1 ? 1 : 3,
      commandClientOpId: operationId.value,
    }),
    operationId.value,
  );
  if (!commandAccepted.ok) return commandAccepted;
  return resumeWorkflow(ctx, found.value);
}

export async function abandonWorkflow(
  ctx: SpineContext,
  workflowId: SpineWorkflowId,
  callerClientOpId: ClientOpId,
): Promise<Result<SpineWorkflow, SpineError>> {
  const operationId = requireClientOpId(callerClientOpId);
  if (!operationId.ok) return operationId;
  const facts = await readAllSteps(ctx);
  if (!facts.ok) return facts;
  const priorCommand = findPriorCommand(facts.value, operationId.value);
  if (priorCommand) {
    if (priorCommand.workflowId !== workflowId) {
      return commandConflict(operationId.value, priorCommand);
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
    commandClientOpId: operationId.value,
  }, operationId.value);
  if (!abandoned.ok) return abandoned;
  return workflowById(ctx, workflowId);
}

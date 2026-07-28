import {
  isAbsent,
  type ClientOpId,
  type Result,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  SpineFailure,
  SpineWorkflow,
} from '../contract/schemas.js';
import type { SpineError } from '../contract/errors.js';
import type { SpineContext } from './ports.js';
import {
  effectFailpointName,
  hitFailpoint,
} from './failpoints.js';
import {
  appendStep,
  journalMutationOpId,
  stepEffectOpId,
  workflowById,
  workflowFactInput,
} from './journal.js';

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

export async function resumeWorkflow(
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

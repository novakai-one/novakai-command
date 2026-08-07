import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeSpine,
  type ComposeSpineOptions,
} from '../contract/index.js';

function dependencies(): Pick<
  ComposeSpineOptions,
  'messaging' | 'projects' | 'artifacts'
> {
  return {
    messaging: {
      async getDelivery() {
        return { kind: 'ok', value: { deliveries: [] } };
      },
    },
    projects: {
      async attach(projectId, input) {
        return {
          ok: true,
          value: {
            kind: 'projectItem',
            id: `projectItem_${input.itemRef.id}`,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            permissionLevel: 'team',
            createdBy: 'sys_spine',
            projectId,
            itemRef: input.itemRef,
            addedBy: 'sys_spine',
            addedVia: 'spine',
          },
        };
      },
    },
    artifacts: {
      async getArtifactMeta() {
        return assert.fail('artifact dependency must not be called');
      },
    },
  };
}

function host(root: string) {
  return composeSpine({
    root,
    principal: 'sys_spine',
    ...dependencies(),
  });
}

async function workflowPausedAfterStepOne(
  root: string,
  originalClientOpId: string,
) {
  process.env.NVK_FAILPOINT = 'spine.journal.step1.done.after';
  const interrupted = await host(root).operations.addMessageToProject({
    messageId: `message_${originalClientOpId}` as never,
    projectId: `proj_${originalClientOpId}` as never,
  }, originalClientOpId as never);
  delete process.env.NVK_FAILPOINT;
  assert.equal(interrupted.ok, false);
  assert.equal(
    interrupted.ok ? null : interrupted.error.code,
    'SpineFailpoint',
  );
  const workflows = await host(root).operations.getSpineWorkflows();
  if (!workflows.ok) return assert.fail(workflows.error.message);
  const workflow = workflows.value.items.find(
    (candidate) =>
      candidate.originalClientOpId === originalClientOpId,
  );
  assert.ok(workflow);
  assert.equal(workflow.state, 'running');
  assert.equal(workflow.nextStep, 2);
  return workflow.workflowId;
}

async function acceptedWorkflow(
  root: string,
  originalClientOpId: string,
) {
  process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
  const interrupted = await host(root).operations.addMessageToProject({
    messageId: `message_${originalClientOpId}` as never,
    projectId: `proj_${originalClientOpId}` as never,
  }, originalClientOpId as never);
  delete process.env.NVK_FAILPOINT;
  assert.equal(interrupted.ok, false);
  const workflows = await host(root).operations.getSpineWorkflows();
  if (!workflows.ok) return assert.fail(workflows.error.message);
  const workflow = workflows.value.items.find(
    (candidate) =>
      candidate.originalClientOpId === originalClientOpId,
  );
  assert.ok(workflow);
  return workflow.workflowId;
}

function assertConflict(
  result: Awaited<
    ReturnType<
      ReturnType<typeof host>['operations']['continueWorkflow']
    >
  >,
) {
  assert.equal(result.ok, false);
  assert.equal(
    result.ok ? null : result.error.code,
    'SpineIdempotencyConflict',
  );
  assert.equal(result.ok ? null : result.error.retryable, false);
}

function journalSnapshot(root: string) {
  const content = readFileSync(
    path.join(root, 'stores', 'spineSteps.jsonl'),
    'utf8',
  );
  return {
    content,
    count: content.trim().length === 0
      ? 0
      : content.trimEnd().split('\n').length,
  };
}

function assertJournalUnchanged(
  before: ReturnType<typeof journalSnapshot>,
  after: ReturnType<typeof journalSnapshot>,
) {
  assert.equal(after.count, before.count);
  assert.equal(after.content, before.content);
}

async function assertLegitimateContinuationCompletes(
  root: string,
  workflowId: Awaited<ReturnType<typeof acceptedWorkflow>>,
  clientOpId: string,
) {
  const result = await host(root).operations.continueWorkflow(
    workflowId,
    clientOpId as never,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.state : null, 'done');
}

for (const scope of ['same', 'cross'] as const) {
  for (const command of ['continue', 'abandon'] as const) {
    test(`${command} rejects a ${scope}-workflow journal transition ID`, async () => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), `nvk-spine-${command}-${scope}-transition-`),
      );
      const root = path.join(workspace, '.novakai');
      const priorFailpoint = process.env.NVK_FAILPOINT;
      try {
        const sourceOpId = `op_${command}_${scope}_source`;
        const sourceWorkflowId = await workflowPausedAfterStepOne(
          root,
          sourceOpId,
        );
        const targetWorkflowId = scope === 'same'
          ? sourceWorkflowId
          : await acceptedWorkflow(root, `op_${command}_${scope}_target`);
        const transitionId =
          `${sourceOpId}:journal:step:1:done` as never;
        const journalPath = path.join(root, 'stores', 'spineSteps.jsonl');
        const before = readFileSync(journalPath, 'utf8');

        const result = command === 'continue'
          ? await host(root).operations.continueWorkflow(
              targetWorkflowId,
              transitionId,
            )
          : await host(root).operations.abandonWorkflow(
              targetWorkflowId,
              transitionId,
            );

        assertConflict(result);
        assert.equal(readFileSync(journalPath, 'utf8'), before);
      } finally {
        if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
        else process.env.NVK_FAILPOINT = priorFailpoint;
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}

test('workflow start rejects an existing journal transition ID', async () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'nvk-spine-start-transition-'),
  );
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    const sourceOpId = 'op_start_transition_source';
    await workflowPausedAfterStepOne(root, sourceOpId);
    const journalPath = path.join(root, 'stores', 'spineSteps.jsonl');
    const before = readFileSync(journalPath, 'utf8');
    const result = await host(root).operations.addMessageToProject({
      messageId: 'message_start_transition_target' as never,
      projectId: 'proj_start_transition_target' as never,
    }, `${sourceOpId}:journal:step:1:done` as never);

    assertConflict(result);
    assert.equal(readFileSync(journalPath, 'utf8'), before);
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('deduplicated journal append rejects a semantically different stored step', async () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'nvk-spine-semantic-dedup-'),
  );
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    const collisionId = 'op_semantic_dedup_collision';
    const handle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'spine',
      allowedKinds: ['spineStep'],
      principal: 'sys_spine',
    });
    const seeded = await createObject(handle, {
      kind: 'spineStep',
      id: 'spineStep_semantic_dedup_seed',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'ignored',
      workflowId: 'spineWorkflow_semantic_dedup_seed',
      workflowType: 'addMessageToProject',
      originalClientOpId: 'op_semantic_dedup_seed',
      projectId: 'proj_semantic_dedup_seed',
      sourceRef: {
        kind: 'message',
        id: 'message_semantic_dedup_seed',
      },
      state: 'accepted',
      step: 0,
      eventIndex: 0,
    }, collisionId as never);
    assert.equal(seeded.ok, true);

    const targetWorkflowId = await acceptedWorkflow(
      root,
      'op_semantic_dedup_target',
    );
    const journalPath = path.join(root, 'stores', 'spineSteps.jsonl');
    const before = readFileSync(journalPath, 'utf8');
    const result = await host(root).operations.continueWorkflow(
      targetWorkflowId,
      collisionId as never,
    );

    assertConflict(result);
    assert.equal(readFileSync(journalPath, 'utf8'), before);
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const scope of ['same', 'cross'] as const) {
  for (const command of ['continue', 'abandon'] as const) {
    test(`${command} preflights a ${scope}-workflow future transition ID`, async () => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), `nvk-spine-${command}-${scope}-future-`),
      );
      const root = path.join(workspace, '.novakai');
      const priorFailpoint = process.env.NVK_FAILPOINT;
      try {
        const sourceOpId = `op_${command}_${scope}_future_source`;
        const sourceWorkflowId = await acceptedWorkflow(root, sourceOpId);
        const targetWorkflowId = scope === 'same'
          ? sourceWorkflowId
          : await acceptedWorkflow(
              root,
              `op_${command}_${scope}_future_target`,
            );
        const reservedFutureId =
          `${sourceOpId}:journal:step:1:done` as never;
        const before = journalSnapshot(root);

        const result = command === 'continue'
          ? await host(root).operations.continueWorkflow(
              targetWorkflowId,
              reservedFutureId,
            )
          : await host(root).operations.abandonWorkflow(
              targetWorkflowId,
              reservedFutureId,
            );

        assertConflict(result);
        assertJournalUnchanged(before, journalSnapshot(root));
        await assertLegitimateContinuationCompletes(
          root,
          targetWorkflowId,
          `op_${command}_${scope}_legitimate`,
        );
      } finally {
        if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
        else process.env.NVK_FAILPOINT = priorFailpoint;
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}

for (const step of [1, 2] as const) {
  for (const state of ['running', 'done', 'failed'] as const) {
    test(`workflow acceptance preflights reserved step ${step} ${state} identity`, async () => {
      const workspace = mkdtempSync(
        path.join(tmpdir(), `nvk-spine-start-future-${step}-${state}-`),
      );
      const root = path.join(workspace, '.novakai');
      const priorFailpoint = process.env.NVK_FAILPOINT;
      try {
        const sourceOpId = `op_start_future_${step}_${state}_source`;
        const sourceWorkflowId = await acceptedWorkflow(root, sourceOpId);
        const before = journalSnapshot(root);
        const result = await host(root).operations.addMessageToProject({
          messageId: `message_start_future_${step}_${state}` as never,
          projectId: `proj_start_future_${step}_${state}` as never,
        }, `${sourceOpId}:journal:step:${step}:${state}` as never);

        assertConflict(result);
        assertJournalUnchanged(before, journalSnapshot(root));
        await assertLegitimateContinuationCompletes(
          root,
          sourceWorkflowId,
          `op_start_future_${step}_${state}_legitimate`,
        );
      } finally {
        if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
        else process.env.NVK_FAILPOINT = priorFailpoint;
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}

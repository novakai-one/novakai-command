import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeSpine } from '../contract/index.js';

function composeMessageWorkflow(root: string) {
  return composeSpine({
    root,
    principal: 'sys_spine',
    messaging: {
      async getDelivery() {
        return { kind: 'ok', value: { deliveries: [] } };
      },
    },
    artifacts: {
      async getArtifactMeta() {
        return assert.fail('artifact dependency must not be called');
      },
    },
    projects: {
      async attach(projectId, input) {
        return {
          ok: true,
          value: {
            kind: 'projectItem',
            id: 'projectItem_command_identity',
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
  });
}

async function acceptOnly(
  root: string,
  originalClientOpId: string,
) {
  process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
  const accepting = composeMessageWorkflow(root);
  const result = await accepting.operations.addMessageToProject({
    messageId: `message_${originalClientOpId}` as never,
    projectId: `proj_${originalClientOpId}` as never,
  }, originalClientOpId as never);
  delete process.env.NVK_FAILPOINT;
  assert.equal(result.ok, false);
  const scan = await composeMessageWorkflow(root).boot.scanWorkflows();
  if (!scan.ok) return assert.fail(scan.error.message);
  const workflow = scan.value.items.find(
    (candidate) => candidate.originalClientOpId === originalClientOpId,
  );
  assert.ok(workflow);
  return workflow.workflowId;
}

test('client operation identity includes workflow command intent', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-command-id-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    const continuedWorkflowId = await acceptOnly(
      root,
      'op_command_source_continue',
    );
    process.env.NVK_FAILPOINT = 'spine.journal.step1.running.after';
    const continuing = composeMessageWorkflow(root);
    const continueClientOpId = 'op_command_shared' as never;
    const interruptedContinue =
      await continuing.operations.continueWorkflow(
        continuedWorkflowId,
        continueClientOpId,
      );
    delete process.env.NVK_FAILPOINT;
    assert.equal(interruptedContinue.ok, false);
    assert.equal(
      interruptedContinue.ok ? null : interruptedContinue.error.code,
      'SpineFailpoint',
    );

    const wrongCommand = await composeMessageWorkflow(root)
      .operations.abandonWorkflow(
        continuedWorkflowId,
        continueClientOpId,
      );
    assert.equal(wrongCommand.ok, false);
    assert.equal(
      wrongCommand.ok ? null : wrongCommand.error.code,
      'SpineIdempotencyConflict',
    );
    assert.deepEqual(
      wrongCommand.ok
      || wrongCommand.error.code !== 'SpineIdempotencyConflict'
        ? []
        : wrongCommand.error.details.differingFields,
      ['commandKind'],
    );

    const sameCommandRetry = await composeMessageWorkflow(root)
      .operations.continueWorkflow(
        continuedWorkflowId,
        continueClientOpId,
      );
    assert.equal(sameCommandRetry.ok, true);
    assert.equal(
      sameCommandRetry.ok ? sameCommandRetry.value.state : null,
      'done',
    );

    const acceptanceClientOpId = 'op_command_source_original';
    const originalWorkflowId = await acceptOnly(
      root,
      acceptanceClientOpId,
    );
    for (const command of ['continue', 'abandon'] as const) {
      const reused = command === 'continue'
        ? await composeMessageWorkflow(root).operations.continueWorkflow(
            originalWorkflowId,
            acceptanceClientOpId as never,
          )
        : await composeMessageWorkflow(root).operations.abandonWorkflow(
            originalWorkflowId,
            acceptanceClientOpId as never,
          );
      assert.equal(reused.ok, false, command);
      assert.equal(
        reused.ok ? null : reused.error.code,
        'SpineIdempotencyConflict',
        command,
      );
    }

    const abandonedWorkflowId = await acceptOnly(
      root,
      'op_command_source_abandon',
    );
    const abandonClientOpId = 'op_command_abandon' as never;
    const abandoned = await composeMessageWorkflow(root)
      .operations.abandonWorkflow(
        abandonedWorkflowId,
        abandonClientOpId,
      );
    const abandonRetry = await composeMessageWorkflow(root)
      .operations.abandonWorkflow(
        abandonedWorkflowId,
        abandonClientOpId,
      );
    assert.equal(abandoned.ok, true);
    assert.equal(abandonRetry.ok, true);

    const journal = readFileSync(
      path.join(root, 'stores', 'spineSteps.jsonl'),
      'utf8',
    );
    assert.match(journal, /"commandKind":"continue"/);
    assert.match(journal, /"commandKind":"abandon"/);
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

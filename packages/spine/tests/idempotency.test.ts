import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeSpine } from '../contract/index.js';

test('original clientOpId retry folds one workflow and rejects mismatched inputs', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-idempotency-'));
  const root = path.join(workspace, '.novakai');
  let messageQueries = 0;
  let projectAttaches = 0;
  try {
    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          messageQueries += 1;
          return { kind: 'ok', value: { deliveries: [] } };
        },
      },
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('artifacts must not be called');
        },
      },
      projects: {
        async attach(projectId, input) {
          projectAttaches += 1;
          return {
            ok: true,
            value: {
              kind: 'projectItem',
              id: 'projectItem_idempotent',
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              permissionLevel: 'team',
              createdBy: 'sys_spine',
              projectId,
              itemRef: input.itemRef,
              ...(input.note === undefined ? {} : { note: input.note }),
              addedBy: 'sys_spine',
              addedVia: 'spine',
            },
          };
        },
      },
    });
    const input = {
      messageId: 'message_same' as never,
      projectId: 'proj_same' as never,
      note: 'same input',
    };

    const first = await spine.operations.addMessageToProject(
      input,
      'op_same_workflow' as never,
    );
    const retry = await spine.operations.addMessageToProject(
      input,
      'op_same_workflow' as never,
    );

    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    if (!first.ok || !retry.ok) return;
    assert.equal(retry.value.workflowId, first.value.workflowId);
    assert.equal(messageQueries, 1);
    assert.equal(projectAttaches, 1);

    const mismatch = await spine.operations.addMessageToProject({
      ...input,
      projectId: 'proj_different' as never,
    }, 'op_same_workflow' as never);
    assert.equal(mismatch.ok, false);
    assert.equal(
      mismatch.ok ? null : mismatch.error.code,
      'SpineIdempotencyConflict',
    );
    assert.equal(messageQueries, 1);
    assert.equal(projectAttaches, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

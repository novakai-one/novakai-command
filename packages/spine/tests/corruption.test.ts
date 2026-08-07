import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
} from '@novakai/foundation/dist/contract/index.js';
import { composeSpine } from '../contract/index.js';

test('workflow folding surfaces an orphan transition as typed journal corruption', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-corrupt-'));
  const root = path.join(workspace, '.novakai');
  try {
    const illicitFactWriter = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'spine',
      allowedKinds: ['spineStep'],
      principal: 'sys_spine',
    });
    const injected = await createObject(illicitFactWriter, {
      kind: 'spineStep',
      id: 'spineStep_orphan_running',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'sys_spine',
      workflowId: 'spineWorkflow_orphan',
      workflowType: 'addMessageToProject',
      originalClientOpId: 'op_orphan',
      projectId: 'proj_orphan',
      sourceRef: { kind: 'message', id: 'message_orphan' },
      state: 'running',
      step: 1,
      eventIndex: 1,
      effectOpId: 'op_orphan:step:1',
    }, 'op_orphan_running' as never);
    assert.equal(injected.ok, true);

    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          return assert.fail('dependency must not be called');
        },
      },
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('dependency must not be called');
        },
      },
      projects: {
        async attach() {
          return assert.fail('dependency must not be called');
        },
      },
    });

    const folded = await spine.operations.getSpineWorkflows();
    assert.equal(folded.ok, false);
    assert.equal(
      folded.ok ? null : folded.error.code,
      'SpineJournalCorrupt',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
} from '@novakai/foundation/dist/contract/index.js';
import { composeSpine } from '../contract/index.js';

function inertDependencies() {
  return {
    messaging: {
      async getDelivery() {
        return assert.fail('workflow listing must not call Messaging');
      },
    },
    artifacts: {
      async getArtifactMeta() {
        return assert.fail('workflow listing must not call Artifacts');
      },
    },
    projects: {
      async attach() {
        return assert.fail('workflow listing must not call Projects');
      },
    },
  };
}

test('journal folding and boot discovery exhaust every page beyond 100 facts', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-pages-'));
  const root = path.join(workspace, '.novakai');
  try {
    const writer = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'spine',
      allowedKinds: ['spineStep'],
      principal: 'sys_spine',
    });
    const acceptedAt = Date.parse('2026-07-29T00:00:00.000Z');
    for (let index = 0; index < 105; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const clientOpId = `op_page_${suffix}` as never;
      const created = await createObject(writer, {
        kind: 'spineStep',
        id: `spineStep_page_${suffix}`,
        schemaVersion: 1,
        createdAt: new Date(acceptedAt + index).toISOString(),
        permissionLevel: 'team',
        createdBy: 'derived-by-foundation',
        workflowId: `spineWorkflow_page_${suffix}`,
        workflowType: 'addMessageToProject',
        originalClientOpId: clientOpId,
        projectId: `proj_page_${suffix}`,
        sourceRef: {
          kind: 'message',
          id: `message_page_${suffix}`,
        },
        state: 'accepted',
        step: 0,
        eventIndex: 0,
      }, clientOpId);
      assert.equal(created.ok, true, suffix);
    }

    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      ...inertDependencies(),
    });
    const all = await spine.operations.getSpineWorkflows();
    assert.equal(all.ok, true);
    assert.equal(all.ok ? all.value.items.length : -1, 105);
    assert.equal(all.ok ? all.value.nextCursor : undefined, undefined);
    assert.equal(
      all.ok ? all.value.items.at(-1)?.workflowId : null,
      'spineWorkflow_page_104',
    );

    const resumable = await spine.boot.scanWorkflows();
    assert.equal(resumable.ok, true);
    assert.equal(resumable.ok ? resumable.value.items.length : -1, 105);
    assert.ok(
      resumable.ok
      && resumable.value.items.every((workflow) => workflow.resumable),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('journal read contention is surfaced as typed retryable storage data', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-lock-'));
  const root = path.join(workspace, '.novakai');
  try {
    mkdirSync(path.join(root, 'lock'), { recursive: true });
    writeFileSync(
      path.join(root, 'lock', 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'held-by-test' })}\n`,
    );
    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      lockTimeoutMs: 20,
      ...inertDependencies(),
    });

    const workflows = await spine.operations.getSpineWorkflows();
    assert.equal(workflows.ok, false);
    assert.equal(workflows.ok ? null : workflows.error.code, 'LockBusy');
    assert.equal(workflows.ok ? null : workflows.error.retryable, true);
    assert.equal(
      workflows.ok || workflows.error.code !== 'LockBusy'
        ? null
        : workflows.error.details.timeoutMs,
      20,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

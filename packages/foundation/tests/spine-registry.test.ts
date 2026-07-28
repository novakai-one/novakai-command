import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
  mintClientOpId,
  queryTraceBound,
  type ObjectKind,
} from '../contract/index.js';
import { composeEngine } from '../contract/compose.js';

test('Foundation persists each Spine journal fact in the canonical store with one trace', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-registry-'));
  const root = path.join(workspace, '.novakai');
  try {
    const kind: ObjectKind = 'spineStep';
    const handle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'spine',
      allowedKinds: [kind],
      principal: 'sys_spine',
    });
    const clientOpId = mintClientOpId();

    const created = await createObject(handle, {
      kind,
      id: 'spineStep_registry',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team' as const,
      createdBy: 'caller_spoof_is_ignored',
      workflowId: 'spineWorkflow_registry',
      workflowType: 'addMessageToProject',
      state: 'accepted',
      step: 0,
      sourceRef: { kind: 'message', id: 'message_registry' },
      projectId: 'proj_registry',
      originalClientOpId: clientOpId,
    }, clientOpId);

    assert.equal(created.ok, true);
    assert.equal(
      existsSync(path.join(root, 'stores', 'spineSteps.jsonl')),
      true,
    );
    assert.equal(created.ok ? created.value.object.createdBy : null, 'sys_spine');

    const engine = composeEngine({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'spine',
      allowedKinds: [kind],
      principal: 'sys_spine',
    });
    const traces = await queryTraceBound(engine, { clientOpId });
    assert.equal(traces.items.length, 1);
    assert.equal(traces.items[0]?.target.kind, 'spineStep');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

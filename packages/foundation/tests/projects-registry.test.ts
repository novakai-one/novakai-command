import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
  mintClientOpId,
  type CapabilityId,
  type ObjectKind,
} from '../contract/index.js';

test('Foundation registers the Projects capability and its two owned kinds', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-registry-'));
  try {
    const capability: CapabilityId = 'projects';
    const kinds: ObjectKind[] = ['project', 'projectItem'];
    const handle = composeHandle({
      root,
      capability,
      allowedKinds: kinds,
      principal: 'person_chris',
    });

    const project = await createObject(handle, {
      kind: 'project',
      id: 'project_registry',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'caller_is_not_trusted',
      title: 'Registry proof',
      status: 'active',
    }, mintClientOpId());
    const item = await createObject(handle, {
      kind: 'projectItem',
      id: 'projectItem_registry',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'caller_is_not_trusted',
      projectId: 'project_registry',
      itemRef: { kind: 'trace', id: 'trace_dangling' },
      addedBy: 'person_chris',
      addedVia: 'spine',
    }, mintClientOpId());

    assert.equal(project.ok, true);
    assert.equal(item.ok, true);
    assert.equal(existsSync(path.join(root, 'projects.jsonl')), true);
    assert.equal(existsSync(path.join(root, 'projectItems.jsonl')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

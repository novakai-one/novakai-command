import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
  mintClientOpId,
  queryTraceBound,
  recordSystemAction,
  type CapabilityId,
  type ObjectKind,
} from '../contract/index.js';
import { composeEngine } from '../contract/compose.js';

test('Foundation registers the Artifacts capability and its owned artifact kind', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-artifacts-registry-'));
  try {
    const capability: CapabilityId = 'artifacts';
    const kind: ObjectKind = 'artifact';
    const handle = composeHandle({
      root,
      capability,
      allowedKinds: [kind],
      principal: 'person_chris',
    });

    const artifact = await createObject(handle, {
      kind,
      id: 'artifact_registry',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'caller_is_not_trusted',
      mimeType: 'text/plain',
      byteSize: 4,
    }, mintClientOpId());

    assert.equal(artifact.ok, true);
    assert.equal(existsSync(path.join(root, 'artifacts.jsonl')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Foundation records the named artifact orphan sweep system action', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-artifacts-sweep-action-'));
  try {
    const handle = composeHandle({
      root,
      capability: 'artifacts',
      allowedKinds: ['artifact'],
      principal: 'sys_reconciler',
    });
    const clientOpId = mintClientOpId();

    const recorded = await recordSystemAction(handle, {
      action: 'artifact.orphan.sweep',
      target: { kind: 'artifact', id: 'artifact_orphan' },
      clientOpId,
      meta: { entryType: 'final' },
    });

    assert.equal(recorded.ok, true);
    const traces = await queryTraceBound(
      composeEngine({
        root,
        capability: 'artifacts',
        allowedKinds: ['artifact'],
        principal: 'sys_reconciler',
      }),
      { clientOpId },
    );
    assert.equal(traces.items.length, 1);
    assert.equal(traces.items[0].action, 'artifact.orphan.sweep');
    assert.equal(traces.items[0].opKind, 'system.action');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

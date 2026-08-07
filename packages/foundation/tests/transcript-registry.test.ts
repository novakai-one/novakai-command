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
  type ObjectKind,
} from '../contract/index.js';

test('Foundation registers Transcript-owned line, journal, and checkpoint kinds', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-registry-'));
  const root = path.join(workspace, '.novakai');
  const dataRoot = path.join(root, 'stores');
  try {
    const kinds: ObjectKind[] = [
      'transcriptLine',
      'transcriptJournal',
      'transcriptCheckpoint',
    ];
    const handle = composeHandle({
      root,
      dataRoot,
      capability: 'transcript',
      allowedKinds: kinds,
      principal: 'sys_ingester',
    });
    const now = new Date().toISOString();

    for (const kind of kinds) {
      const created = await createObject(handle, {
        kind,
        id: `${kind}_registry`,
        schemaVersion: 1,
        createdAt: now,
        permissionLevel: 'private',
        createdBy: 'caller_spoof_is_ignored',
      }, mintClientOpId());
      assert.equal(created.ok, true);
      assert.equal(
        created.ok ? created.value.object.createdBy : null,
        'sys_ingester',
      );
    }

    assert.equal(existsSync(path.join(dataRoot, 'transcriptLines.jsonl')), true);
    assert.equal(existsSync(path.join(dataRoot, 'transcriptJournal.jsonl')), true);
    assert.equal(existsSync(path.join(dataRoot, 'transcriptCheckpoints.jsonl')), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

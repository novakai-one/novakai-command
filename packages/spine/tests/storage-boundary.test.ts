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
import { composeSpine } from '../contract/index.js';

function composeInertSpine(root: string) {
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
        return assert.fail('storage failure must precede Artifacts');
      },
    },
    projects: {
      async attach() {
        return assert.fail('storage failure must precede Projects');
      },
    },
  });
}

test('journal filesystem failures remain typed across query and mutation seams', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-storage-'));
  try {
    const invalidRoot = path.join(workspace, 'root-is-a-file');
    writeFileSync(invalidRoot, 'not a directory\n');
    const invalidHost = composeInertSpine(invalidRoot);

    const queried = await invalidHost.operations.getSpineWorkflows();
    assert.equal(queried.ok, false);
    assert.equal(
      queried.ok ? null : queried.error.code,
      'SpineJournalReadFailed',
    );
    assert.equal(queried.ok ? null : queried.error.retryable, false);

    const mutated = await invalidHost.operations.addMessageToProject({
      messageId: 'message_storage_read' as never,
      projectId: 'proj_storage_read' as never,
    }, 'op_storage_read' as never);
    assert.equal(mutated.ok, false);
    assert.equal(
      mutated.ok ? null : mutated.error.code,
      'SpineJournalReadFailed',
    );

    const writeRoot = path.join(workspace, 'write-root');
    const writeHost = composeInertSpine(writeRoot);
    const warmed = await writeHost.operations.getSpineWorkflows();
    assert.equal(warmed.ok, true);
    mkdirSync(
      path.join(writeRoot, 'stores', 'traces.jsonl'),
      { recursive: true },
    );

    const written = await writeHost.operations.addMessageToProject({
      messageId: 'message_storage_write' as never,
      projectId: 'proj_storage_write' as never,
    }, 'op_storage_write' as never);
    assert.equal(written.ok, false);
    assert.equal(
      written.ok ? null : written.error.code,
      'SpineJournalWriteFailed',
    );
    assert.equal(written.ok ? null : written.error.retryable, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve('../../scripts/b2a-second-host.ts');
const TSX = fileURLToPath(import.meta.resolve('tsx/cli'));

test('the CLI-only second host proves the complete B2a lifecycle without Server or UI', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-second-host-'));
  const root = path.join(workspace, '.novakai');
  try {
    const result = spawnSync(
      process.execPath,
      [TSX, SCRIPT, '--root', root],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NOVAKAI_ROOT: root,
        },
      },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const proof = JSON.parse(result.stdout) as {
      projectId: string;
      artifactId: string;
      artifactBytesVerified: boolean;
      artifactMetaVerified: boolean;
      artifactListVerified: boolean;
      workflowStates: string[];
      continuedState: string;
      abandonedState: string;
      projectRefs: Array<{ kind: string; id: string }>;
      serverStarted: boolean;
      uiUsed: boolean;
    };
    assert.match(proof.projectId, /^proj_/);
    assert.match(proof.artifactId, /^artifact_/);
    assert.equal(proof.artifactBytesVerified, true);
    assert.equal(proof.artifactMetaVerified, true);
    assert.equal(proof.artifactListVerified, true);
    assert.deepEqual(proof.workflowStates, ['done', 'done']);
    assert.equal(proof.continuedState, 'done');
    assert.equal(proof.abandonedState, 'abandoned');
    assert.equal(
      proof.projectRefs.some(({ kind, id }) =>
        kind === 'message' && id.startsWith('message_')),
      true,
    );
    assert.equal(
      proof.projectRefs.some(({ kind, id }) =>
        kind === 'artifact' && id === proof.artifactId),
      true,
    );
    assert.equal(proof.serverStarted, false);
    assert.equal(proof.uiUsed, false);

    const journal = readFileSync(
      path.join(root, 'stores', 'spineSteps.jsonl'),
      'utf8',
    );
    assert.match(journal, /"state":"accepted"/);
    assert.match(journal, /"state":"abandoned"/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

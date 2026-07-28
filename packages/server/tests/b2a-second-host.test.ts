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

function readJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

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

    const journal = readJsonl<{
      envelope: { createdBy: string };
      payload: { state: string };
    }>(
      path.join(root, 'stores', 'spineSteps.jsonl'),
    );
    assert.equal(
      journal.every(({ envelope }) =>
        envelope.createdBy === 'person_secondhost'),
      true,
      'offline Spine journal identity derives from the authenticated token',
    );
    assert.equal(
      journal.some(({ payload }) => payload.state === 'accepted'),
      true,
    );
    assert.equal(
      journal.some(({ payload }) => payload.state === 'abandoned'),
      true,
    );

    const spineTraces = readJsonl<{
      createdBy: string;
      target: { kind: string };
    }>(path.join(root, 'stores', 'traces.jsonl'))
      .filter(({ target }) => target.kind === 'spineStep');
    assert.ok(spineTraces.length > 0);
    assert.equal(
      spineTraces.every(({ createdBy }) =>
        createdBy === 'person_secondhost'),
      true,
      'offline Spine trace identity derives from the authenticated token',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

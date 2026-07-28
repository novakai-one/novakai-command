import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
  createArtifactsContract,
} from '../contract/index.js';

test('artifact byte durability completes outside the held Foundation global lock', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-lock-'));
  const root = path.join(workspace, '.novakai');
  const lockDir = path.join(root, 'lock');
  try {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'live-test-holder' })}\n`,
    );
    const artifacts = createArtifactsContract(composeArtifacts({
      root,
      principal: 'person_chris',
      lockTimeoutMs: 50,
    }));
    const bytes = Buffer.from('bytes finish before lock contention', 'utf8');

    const result = await artifacts.putArtifact({
      bytes,
      mimeType: 'text/plain',
    }, mintClientOpId());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'LockBusy');
    const byteFiles = readdirSync(path.join(root, 'artifacts'));
    assert.equal(byteFiles.length, 1);
    assert.equal(byteFiles[0].startsWith('artifact_'), true);
    assert.deepEqual(
      readFileSync(path.join(root, 'artifacts', byteFiles[0])),
      bytes,
    );
    assert.equal(existsSync(path.join(root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

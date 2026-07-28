import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
  createArtifactsContract,
} from '../contract/index.js';

async function runPutAt(point: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-failpoint-'));
  const root = path.join(workspace, '.novakai');
  const prior = process.env.NVK_FAILPOINT;
  process.env.NVK_FAILPOINT = point;
  try {
    const artifacts = createArtifactsContract(composeArtifacts({
      root,
      principal: 'person_chris',
    }));
    const result = await artifacts.putArtifact({
      bytes: Buffer.from('failpoint payload', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    return { workspace, root, result };
  } finally {
    if (prior === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = prior;
  }
}

test('NVK_FAILPOINT names deterministic before/after temp-write failures', async () => {
  const before = await runPutAt('artifacts.put.before-temp-write');
  try {
    assert.equal(before.result.ok, false);
    if (before.result.ok) return;
    assert.equal(before.result.error.code, 'ArtifactFailpoint');
    assert.equal(
      (before.result.error.details as { point: string }).point,
      'artifacts.put.before-temp-write',
    );
    assert.deepEqual(
      existsSync(path.join(before.root, 'artifacts'))
        ? readdirSync(path.join(before.root, 'artifacts'))
        : [],
      [],
    );
    assert.equal(existsSync(path.join(before.root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(before.workspace, { recursive: true, force: true });
  }

  const after = await runPutAt('artifacts.put.after-temp-write');
  try {
    assert.equal(after.result.ok, false);
    if (after.result.ok) return;
    assert.equal(after.result.error.code, 'ArtifactFailpoint');
    assert.equal(
      (after.result.error.details as { point: string }).point,
      'artifacts.put.after-temp-write',
    );
    assert.equal(readdirSync(path.join(after.root, 'artifacts')).length, 1);
    assert.equal(existsSync(path.join(after.root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(after.workspace, { recursive: true, force: true });
  }
});

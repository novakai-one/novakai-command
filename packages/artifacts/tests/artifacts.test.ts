import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
  createArtifactsContract,
} from '../contract/index.js';

test('putArtifact durably stores exact bytes before metadata and returns metadata only', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-put-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = createArtifactsContract(composeArtifacts({
      root,
      principal: 'person_chris',
    }));
    const bytes = Buffer.from('artifact bytes stay out of jsonl', 'utf8');

    const result = await artifacts.putArtifact({
      bytes,
      mimeType: 'text/plain',
      originPath: '/evidence/result.txt',
      permissionLevel: 'team',
    }, mintClientOpId());

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.value.id, /^artifact_/);
    assert.equal(result.value.byteSize, bytes.byteLength);
    assert.equal(result.value.mimeType, 'text/plain');
    assert.equal(result.value.originPath, '/evidence/result.txt');
    assert.equal(result.value.createdBy, 'person_chris');
    assert.equal('bytes' in result.value, false);
    assert.deepEqual(
      readFileSync(path.join(root, 'artifacts', result.value.id)),
      bytes,
    );
    assert.equal(existsSync(path.join(root, 'stores', 'artifacts.jsonl')), false);
    const recordText = readFileSync(path.join(root, 'artifacts.jsonl'), 'utf8');
    assert.equal(recordText.includes(bytes.toString('utf8')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

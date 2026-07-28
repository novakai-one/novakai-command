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

test('getArtifactMeta retrieves metadata through the public contract', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-meta-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = createArtifactsContract(composeArtifacts({
      root,
      principal: 'person_chris',
    }));
    const put = await artifacts.putArtifact({
      bytes: Buffer.from('metadata proof', 'utf8'),
      mimeType: 'text/markdown',
      originPath: '/evidence/proof.md',
    }, mintClientOpId());
    assert.equal(put.ok, true);
    if (!put.ok) return;

    const found = await artifacts.getArtifactMeta(put.value.id);

    assert.equal(found.ok, true);
    if (!found.ok || 'absent' in found.value) return;
    assert.deepEqual(found.value, put.value);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('listArtifacts returns artifact metadata without byte payloads', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-list-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = createArtifactsContract(composeArtifacts({
      root,
      principal: 'person_chris',
    }));
    const first = await artifacts.putArtifact({
      bytes: Buffer.from('one', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    const second = await artifacts.putArtifact({
      bytes: Buffer.from([0, 1, 2, 3]),
      mimeType: 'application/octet-stream',
    }, mintClientOpId());
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    const listed = await artifacts.listArtifacts();

    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.deepEqual(
      new Set(listed.value.items.map((artifact) => artifact.id)),
      new Set([first.value.id, second.value.id]),
    );
    assert.equal(
      listed.value.items.every((artifact) => !('bytes' in artifact)),
      true,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

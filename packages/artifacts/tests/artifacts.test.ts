import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
  type ArtifactId,
} from '../contract/index.js';

test('putArtifact durably stores exact bytes before metadata and returns metadata only', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-put-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;
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
    assert.equal(existsSync(path.join(root, 'stores', 'artifacts.jsonl')), true);
    assert.equal(existsSync(path.join(root, 'stores', 'traces.jsonl')), true);
    assert.equal(existsSync(path.join(root, 'artifacts.jsonl')), false);
    assert.equal(existsSync(path.join(root, 'traces.jsonl')), false);
    const recordText = readFileSync(
      path.join(root, 'stores', 'artifacts.jsonl'),
      'utf8',
    );
    assert.equal(recordText.includes(bytes.toString('utf8')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('getArtifactMeta retrieves metadata through the public contract', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-meta-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;
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
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;
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

test('getArtifactBytes retrieves the exact durable byte payload', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-bytes-'));
  const root = path.join(workspace, '.novakai');
  try {
    const host = composeArtifacts({
      root,
      principal: 'person_chris',
    });
    const artifacts = host.operations;
    const bytes = Buffer.from([0, 255, 17, 34, 51, 68]);
    const put = await artifacts.putArtifact({
      bytes,
      mimeType: 'application/octet-stream',
    }, mintClientOpId());
    assert.equal(put.ok, true);
    if (!put.ok) return;

    const found = await host.http.getArtifactBytes(put.value.id);

    assert.equal(found.ok, true);
    if (!found.ok || 'absent' in found.value) return;
    assert.deepEqual(Buffer.from(found.value), bytes);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('putArtifact retry with the same clientOpId returns one durable artifact', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-retry-'));
  const root = path.join(workspace, '.novakai');
  try {
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;
    const clientOpId = mintClientOpId();
    const input = {
      bytes: Buffer.from('retry once', 'utf8'),
      mimeType: 'text/plain',
    };

    const first = await artifacts.putArtifact(input, clientOpId);
    const retried = await artifacts.putArtifact(input, clientOpId);

    assert.equal(first.ok, true);
    assert.equal(retried.ok, true);
    if (!first.ok || !retried.ok) return;
    assert.deepEqual(retried.value, first.value);
    const listed = await artifacts.listArtifacts();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.items.length, 1);
    assert.deepEqual(readdirSync(path.join(root, 'artifacts')), [first.value.id]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('getArtifactBytes reports typed missing bytes when metadata still exists', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-missing-'));
  const root = path.join(workspace, '.novakai');
  try {
    const host = composeArtifacts({
      root,
      principal: 'person_chris',
    });
    const artifacts = host.operations;
    const put = await artifacts.putArtifact({
      bytes: Buffer.from('will be externally removed', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(put.ok, true);
    if (!put.ok) return;
    unlinkSync(path.join(root, 'artifacts', put.value.id));

    const found = await host.http.getArtifactBytes(put.value.id);

    assert.equal(found.ok, false);
    if (found.ok) return;
    assert.equal(found.error.code, 'ArtifactBytesMissing');
    assert.deepEqual(
      (found.error.details as { ref: { kind: string; id: string } }).ref,
      { kind: 'artifact', id: put.value.id },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('putArtifact returns a typed error when byte-directory creation fails', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-mkdir-'));
  const root = path.join(workspace, '.novakai');
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'artifacts'), 'blocks directory creation');
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;

    const result = await artifacts.putArtifact({
      bytes: Buffer.from('must return, not throw', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, 'ArtifactByteEffectFailed');
    assert.equal(
      (result.error.details as { effect: string }).effect,
      'temp-write',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('get and list queries return typed absence and empty-page outcomes', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-absent-'));
  const root = path.join(workspace, '.novakai');
  try {
    const host = composeArtifacts({
      root,
      principal: 'person_chris',
    });
    const artifacts = host.operations;
    const artifactId = 'artifact_missing' as ArtifactId;

    const metadata = await artifacts.getArtifactMeta(artifactId);
    const bytes = await host.http.getArtifactBytes(artifactId);
    const listed = await artifacts.listArtifacts();

    assert.deepEqual(metadata, {
      ok: true,
      value: {
        absent: true,
        ref: { kind: 'artifact', id: artifactId },
      },
    });
    assert.deepEqual(bytes, metadata);
    assert.deepEqual(listed, {
      ok: true,
      value: { items: [] },
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('getArtifactMeta translates unreadable Foundation storage to a typed error', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-get-eisdir-'));
  const root = path.join(workspace, '.novakai');
  try {
    mkdirSync(
      path.join(root, 'stores', 'artifacts.jsonl'),
      { recursive: true },
    );
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;

    const result = await artifacts.getArtifactMeta(
      'artifact_unreadable' as ArtifactId,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    const error = result.error as unknown as {
      code: string;
      details: { operation: string };
    };
    assert.equal(error.code, 'ArtifactStoreReadFailed');
    assert.equal(
      error.details.operation,
      'get',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

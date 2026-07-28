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
} from '../contract/index.js';

async function runPutAt(point: string) {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-failpoint-'));
  const root = path.join(workspace, '.novakai');
  const prior = process.env.NVK_FAILPOINT;
  process.env.NVK_FAILPOINT = point;
  try {
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
    }).operations;
    const clientOpId = mintClientOpId();
    const result = await artifacts.putArtifact({
      bytes: Buffer.from('failpoint payload', 'utf8'),
      mimeType: 'text/plain',
    }, clientOpId);
    return { workspace, root, clientOpId, result };
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

test('NVK_FAILPOINT names deterministic before/after temp-fsync failures', async () => {
  for (const point of [
    'artifacts.put.before-temp-fsync',
    'artifacts.put.after-temp-fsync',
  ]) {
    const run = await runPutAt(point);
    try {
      assert.equal(run.result.ok, false);
      if (run.result.ok) return;
      assert.equal(run.result.error.code, 'ArtifactFailpoint');
      assert.equal(
        (run.result.error.details as { point: string }).point,
        point,
      );
      const entries = readdirSync(path.join(run.root, 'artifacts'));
      assert.equal(entries.length, 1);
      assert.match(entries[0], /^\..+\.tmp$/);
      assert.equal(existsSync(path.join(run.root, 'artifacts.jsonl')), false);
    } finally {
      rmSync(run.workspace, { recursive: true, force: true });
    }
  }
});

test('NVK_FAILPOINT names deterministic before/after atomic-rename failures', async () => {
  for (const expectation of [
    {
      point: 'artifacts.put.before-rename',
      final: false,
    },
    {
      point: 'artifacts.put.after-rename',
      final: true,
    },
  ]) {
    const run = await runPutAt(expectation.point);
    try {
      assert.equal(run.result.ok, false);
      if (run.result.ok) return;
      assert.equal(run.result.error.code, 'ArtifactFailpoint');
      assert.equal(
        (run.result.error.details as { point: string }).point,
        expectation.point,
      );
      const entries = readdirSync(path.join(run.root, 'artifacts'));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].startsWith('.'), !expectation.final);
      assert.equal(existsSync(path.join(run.root, 'artifacts.jsonl')), false);
    } finally {
      rmSync(run.workspace, { recursive: true, force: true });
    }
  }
});

test('NVK_FAILPOINT names deterministic before/after record-append failures', async () => {
  const before = await runPutAt('artifacts.put.before-record-append');
  try {
    assert.equal(before.result.ok, false);
    if (before.result.ok) return;
    assert.equal(before.result.error.code, 'ArtifactFailpoint');
    assert.equal(
      (before.result.error.details as { point: string }).point,
      'artifacts.put.before-record-append',
    );
    assert.equal(readdirSync(path.join(before.root, 'artifacts')).length, 1);
    assert.equal(existsSync(path.join(before.root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(before.workspace, { recursive: true, force: true });
  }

  const after = await runPutAt('artifacts.put.after-record-append');
  try {
    assert.equal(after.result.ok, false);
    if (after.result.ok) return;
    assert.equal(after.result.error.code, 'ArtifactFailpoint');
    assert.equal(
      (after.result.error.details as { point: string }).point,
      'artifacts.put.after-record-append',
    );
    const byteFiles = readdirSync(path.join(after.root, 'artifacts'));
    assert.equal(byteFiles.length, 1);
    assert.equal(existsSync(path.join(after.root, 'artifacts.jsonl')), true);

    const artifacts = composeArtifacts({
      root: after.root,
      principal: 'person_chris',
    }).operations;
    const retried = await artifacts.putArtifact({
      bytes: Buffer.from('failpoint payload', 'utf8'),
      mimeType: 'text/plain',
    }, after.clientOpId);
    assert.equal(retried.ok, true);
    assert.deepEqual(
      readdirSync(path.join(after.root, 'artifacts')),
      byteFiles,
    );
  } finally {
    rmSync(after.workspace, { recursive: true, force: true });
  }
});

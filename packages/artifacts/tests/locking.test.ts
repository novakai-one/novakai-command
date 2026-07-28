import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
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
    const artifacts = composeArtifacts({
      root,
      principal: 'person_chris',
      lockTimeoutMs: 50,
    }).operations;
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

test('same-operation concurrent puts serialize publication integrity', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-publication-'));
  try {
    const mismatchedRoot = path.join(workspace, 'mismatched', '.novakai');
    const firstHost = composeArtifacts({
      root: mismatchedRoot,
      principal: 'person_chris',
    });
    const secondHost = composeArtifacts({
      root: mismatchedRoot,
      principal: 'person_chris',
    });
    const mismatchedOp = mintClientOpId();
    const largeBytes = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const smallBytes = Buffer.from('different', 'utf8');

    const mismatched = await Promise.all([
      firstHost.operations.putArtifact({
        bytes: largeBytes,
        mimeType: 'application/octet-stream',
      }, mismatchedOp),
      secondHost.operations.putArtifact({
        bytes: smallBytes,
        mimeType: 'text/plain',
      }, mismatchedOp),
    ]);

    assert.equal(mismatched.filter((result) => result.ok).length, 1);
    assert.equal(mismatched.filter((result) => !result.ok).length, 1);
    const conflict = mismatched.find((result) => !result.ok);
    assert.equal(conflict?.ok, false);
    if (conflict && !conflict.ok) {
      assert.equal(conflict.error.code, 'ArtifactIdempotencyConflict');
    }
    const winner = mismatched.find((result) => result.ok);
    assert.equal(winner?.ok, true);
    if (!winner?.ok) return;
    const published = await firstHost.http.getArtifactBytes(winner.value.id);
    assert.equal(published.ok, true);
    if (!published.ok || 'absent' in published.value) return;
    assert.equal(published.value.byteLength, winner.value.byteSize);

    const matchingRoot = path.join(workspace, 'matching', '.novakai');
    const matchingHost = composeArtifacts({
      root: matchingRoot,
      principal: 'person_chris',
    });
    const matchingOp = mintClientOpId();
    const matchingInput = {
      bytes: Buffer.from('same publication', 'utf8'),
      mimeType: 'text/plain',
    };
    const matching = await Promise.all([
      matchingHost.operations.putArtifact(matchingInput, matchingOp),
      matchingHost.operations.putArtifact(matchingInput, matchingOp),
    ]);
    assert.equal(matching.every((result) => result.ok), true);
    if (!matching[0].ok || !matching[1].ok) return;
    assert.deepEqual(matching[1].value, matching[0].value);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('artifact publication recovers dead and abandoned leases', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-stale-lease-'));
  try {
    for (const scenario of ['dead-owner', 'ownerless'] as const) {
      const root = path.join(workspace, scenario, '.novakai');
      const host = composeArtifacts({
        root,
        principal: 'person_chris',
        lockTimeoutMs: 100,
      });
      const clientOpId = mintClientOpId();
      const input = {
        bytes: Buffer.from(`recover ${scenario}`, 'utf8'),
        mimeType: 'text/plain',
      };
      const created = await host.operations.putArtifact(input, clientOpId);
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const lockDir = path.join(
        root,
        'artifacts',
        '.publication-locks',
        `${created.value.id}.lock`,
      );
      mkdirSync(lockDir, { recursive: true });
      if (scenario === 'dead-owner') {
        writeFileSync(
          path.join(lockDir, 'owner.json'),
          `${JSON.stringify({ pid: 999999, token: 'dead-owner' })}\n`,
        );
      } else {
        const staleAt = new Date(Date.now() - 60_000);
        utimesSync(lockDir, staleAt, staleAt);
      }

      const retried = await host.operations.putArtifact(input, clientOpId);

      assert.equal(retried.ok, true);
      assert.equal(existsSync(lockDir), false);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

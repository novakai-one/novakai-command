import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  __resetDefaultEngine,
  composeHandle,
  createObject,
  mintClientOpId,
  queryTrace,
  type ArtifactId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeArtifacts,
} from '../contract/index.js';

test('boot orphan sweep removes final/temp orphans, preserves records, and traces each deletion without bytes', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-sweep-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const priorRoot = process.env.NOVAKAI_ROOT;
  try {
    const host = composeArtifacts({
      root,
      principal: 'sys_reconciler',
    });
    const artifacts = host.operations;
    const recordedBytes = Buffer.from('recorded bytes survive', 'utf8');
    const recorded = await artifacts.putArtifact({
      bytes: recordedBytes,
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;

    process.env.NVK_FAILPOINT = 'artifacts.put.after-temp-fsync';
    const tempOrphan = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('temp orphan payload', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(tempOrphan.ok, false);

    process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
    const finalOrphan = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('final orphan payload', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(finalOrphan.ok, false);
    delete process.env.NVK_FAILPOINT;

    const swept = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).boot.sweepOrphans();

    assert.equal(swept.ok, true);
    if (!swept.ok) return;
    assert.deepEqual(
      new Set(swept.value.swept.map((entry) => entry.entryType)),
      new Set(['final', 'temp']),
    );
    assert.deepEqual(
      readdirSync(path.join(root, 'artifacts')),
      [recorded.value.id],
    );
    const stillRecorded = await host.http.getArtifactBytes(recorded.value.id);
    assert.equal(stillRecorded.ok, true);
    if (!stillRecorded.ok || 'absent' in stillRecorded.value) return;
    assert.deepEqual(Buffer.from(stillRecorded.value), recordedBytes);

    process.env.NOVAKAI_ROOT = path.join(root, 'stores');
    __resetDefaultEngine();
    const traces = await queryTrace({});
    const sweepTraces = traces.items.filter(
      (trace) => trace.action === 'artifact.orphan.sweep',
    );
    assert.equal(sweepTraces.length, 2);
    assert.equal(
      sweepTraces.every((trace) => trace.opKind === 'system.action'),
      true,
    );
    assert.equal(
      JSON.stringify(sweepTraces).includes('orphan payload'),
      false,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
    else process.env.NOVAKAI_ROOT = priorRoot;
    __resetDefaultEngine();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('boot orphan sweep preserves recorded bytes beyond the first metadata page', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-sweep-pages-'));
  const root = path.join(workspace, '.novakai');
  try {
    const host = composeArtifacts({
      root,
      principal: 'sys_reconciler',
    });
    const recordedIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const recorded = await host.operations.putArtifact({
        bytes: Buffer.from(`recorded-${index}`, 'utf8'),
        mimeType: 'text/plain',
      }, mintClientOpId());
      assert.equal(recorded.ok, true);
      if (!recorded.ok) return;
      recordedIds.push(recorded.value.id);
    }

    const swept = await host.boot.sweepOrphans();

    assert.equal(swept.ok, true);
    if (!swept.ok) return;
    assert.deepEqual(swept.value.swept, []);
    assert.deepEqual(
      new Set(readdirSync(path.join(root, 'artifacts'))),
      new Set(recordedIds),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('NVK_FAILPOINT names deterministic before/after orphan trace-append failures', async () => {
  for (const expectation of [
    {
      point: 'artifacts.sweep.before-trace-append',
      traceCount: 0,
    },
    {
      point: 'artifacts.sweep.after-trace-append',
      traceCount: 1,
    },
  ]) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-trace-'));
    const root = path.join(workspace, '.novakai');
    const priorFailpoint = process.env.NVK_FAILPOINT;
    const priorRoot = process.env.NOVAKAI_ROOT;
    try {
      process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
      const host = composeArtifacts({
        root,
        principal: 'sys_reconciler',
      });
      const artifacts = host.operations;
      const orphaned = await artifacts.putArtifact({
        bytes: Buffer.from('trace failure orphan bytes', 'utf8'),
        mimeType: 'text/plain',
      }, mintClientOpId());
      assert.equal(orphaned.ok, false);

      process.env.NVK_FAILPOINT = expectation.point;
      const swept = await composeArtifacts({
        root,
        principal: 'sys_reconciler',
      }).boot.sweepOrphans();

      assert.equal(swept.ok, false);
      if (swept.ok) return;
      assert.equal(swept.error.code, 'ArtifactFailpoint');
      assert.equal(
        (swept.error.details as { point: string }).point,
        expectation.point,
      );
      assert.equal(readdirSync(path.join(root, 'artifacts')).length, 1);

      delete process.env.NVK_FAILPOINT;
      process.env.NOVAKAI_ROOT = path.join(root, 'stores');
      __resetDefaultEngine();
      const traces = await queryTrace({});
      assert.equal(
        traces.items.filter(
          (trace) => trace.action === 'artifact.orphan.sweep',
        ).length,
        expectation.traceCount,
      );
      assert.equal(
        JSON.stringify(traces.items).includes('orphan bytes'),
        false,
      );
    } finally {
      if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
      else process.env.NVK_FAILPOINT = priorFailpoint;
      if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
      else process.env.NOVAKAI_ROOT = priorRoot;
      __resetDefaultEngine();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('NVK_FAILPOINT names deterministic before/after orphan-delete failures', async () => {
  for (const expectation of [
    {
      point: 'artifacts.sweep.before-delete',
      remaining: 1,
    },
    {
      point: 'artifacts.sweep.after-delete',
      remaining: 0,
    },
  ]) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-delete-'));
    const root = path.join(workspace, '.novakai');
    const priorFailpoint = process.env.NVK_FAILPOINT;
    const priorRoot = process.env.NOVAKAI_ROOT;
    try {
      process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
      const host = composeArtifacts({
        root,
        principal: 'sys_reconciler',
      });
      const artifacts = host.operations;
      const orphaned = await artifacts.putArtifact({
        bytes: Buffer.from('delete failure orphan bytes', 'utf8'),
        mimeType: 'text/plain',
      }, mintClientOpId());
      assert.equal(orphaned.ok, false);

      process.env.NVK_FAILPOINT = expectation.point;
      const swept = await composeArtifacts({
        root,
        principal: 'sys_reconciler',
      }).boot.sweepOrphans();

      assert.equal(swept.ok, false);
      if (swept.ok) return;
      assert.equal(swept.error.code, 'ArtifactFailpoint');
      assert.equal(
        (swept.error.details as { point: string }).point,
        expectation.point,
      );
      assert.equal(
        readdirSync(path.join(root, 'artifacts')).length,
        expectation.remaining,
      );

      delete process.env.NVK_FAILPOINT;
      process.env.NOVAKAI_ROOT = path.join(root, 'stores');
      __resetDefaultEngine();
      const traces = await queryTrace({});
      assert.equal(
        traces.items.filter(
          (trace) => trace.action === 'artifact.orphan.sweep',
        ).length,
        1,
      );
      assert.equal(
        JSON.stringify(traces.items).includes('orphan bytes'),
        false,
      );
    } finally {
      if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
      else process.env.NVK_FAILPOINT = priorFailpoint;
      if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
      else process.env.NOVAKAI_ROOT = priorRoot;
      __resetDefaultEngine();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('orphan sweep retry deletes once with one accepted no-byte trace', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-retry-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const priorRoot = process.env.NOVAKAI_ROOT;
  try {
    process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
    const orphaned = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('retry orphan secret bytes', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(orphaned.ok, false);

    process.env.NVK_FAILPOINT = 'artifacts.sweep.before-delete';
    const firstSweep = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).boot.sweepOrphans();
    assert.equal(firstSweep.ok, false);

    delete process.env.NVK_FAILPOINT;
    const retriedSweep = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).boot.sweepOrphans();

    assert.equal(retriedSweep.ok, true);
    if (!retriedSweep.ok) return;
    assert.equal(readdirSync(path.join(root, 'artifacts')).length, 0);
    process.env.NOVAKAI_ROOT = path.join(root, 'stores');
    __resetDefaultEngine();
    const traces = await queryTrace({});
    const sweepTraces = traces.items.filter(
      (trace) => trace.action === 'artifact.orphan.sweep',
    );
    assert.equal(sweepTraces.length, 1);
    assert.deepEqual(sweepTraces[0].meta, {
      entryType: 'final',
      status: 'accepted',
    });
    assert.equal(
      JSON.stringify(sweepTraces).includes('retry orphan secret bytes'),
      false,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
    else process.env.NOVAKAI_ROOT = priorRoot;
    __resetDefaultEngine();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('orphan sweep translates Foundation trace storage failures and preserves the orphan', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-trace-store-'));
  const root = path.join(workspace, '.novakai');
  try {
    const host = composeArtifacts({
      root,
      principal: 'sys_reconciler',
    });
    const initialized = await host.operations.listArtifacts();
    assert.equal(initialized.ok, true);

    const artifactId = 'artifact_trace-storage-failure';
    const bytesRoot = path.join(root, 'artifacts');
    mkdirSync(bytesRoot, { recursive: true });
    writeFileSync(path.join(bytesRoot, artifactId), 'orphan bytes');
    mkdirSync(path.join(root, 'stores', 'traces.jsonl'), {
      recursive: true,
    });

    const swept = await host.boot.sweepOrphans();

    assert.equal(swept.ok, false);
    if (swept.ok) return;
    assert.equal(swept.error.code, 'ArtifactOrphanTraceFailed');
    assert.deepEqual(readdirSync(bytesRoot), [artifactId]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('concurrent orphan sweeps converge without duplicate traces or ENOENT', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-concurrent-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const priorRoot = process.env.NOVAKAI_ROOT;
  try {
    process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
    const orphaned = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('one concurrently swept orphan', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(orphaned.ok, false);
    delete process.env.NVK_FAILPOINT;

    const [first, second] = await Promise.all([
      composeArtifacts({
        root,
        principal: 'sys_reconciler',
      }).boot.sweepOrphans(),
      composeArtifacts({
        root,
        principal: 'sys_reconciler',
      }).boot.sweepOrphans(),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(
      first.value.swept.length + second.value.swept.length,
      1,
    );
    assert.deepEqual(readdirSync(path.join(root, 'artifacts')), []);

    process.env.NOVAKAI_ROOT = path.join(root, 'stores');
    __resetDefaultEngine();
    const traces = await queryTrace({});
    assert.equal(
      traces.items.filter(
        (trace) => trace.action === 'artifact.orphan.sweep',
      ).length,
      1,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
    else process.env.NOVAKAI_ROOT = priorRoot;
    __resetDefaultEngine();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('orphan sweep rechecks authoritative metadata after acquiring the publication lease', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-recheck-'));
  const root = path.join(workspace, '.novakai');
  const artifactId = 'artifact_publication-recheck' as ArtifactId;
  const bytes = Buffer.from('recorded after sweep snapshot', 'utf8');
  const bytesRoot = path.join(root, 'artifacts');
  const leaseDir = path.join(
    bytesRoot,
    '.publication-locks',
    `${artifactId}.lock`,
  );
  try {
    mkdirSync(leaseDir, { recursive: true });
    writeFileSync(path.join(bytesRoot, artifactId), bytes);
    writeFileSync(
      path.join(leaseDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'test-live-owner' })}\n`,
    );
    const host = composeArtifacts({
      root,
      principal: 'sys_reconciler',
    });

    const sweep = host.boot.sweepOrphans();
    const recorded = await createObject(
      composeHandle({
        root,
        dataRoot: path.join(root, 'stores'),
        capability: 'artifacts',
        allowedKinds: ['artifact'],
        principal: 'person_chris',
      }),
      {
        kind: 'artifact',
        id: artifactId,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        permissionLevel: 'private',
        createdBy: 'overridden-by-foundation',
        mimeType: 'text/plain',
        byteSize: bytes.byteLength,
      },
      mintClientOpId(),
    );
    assert.equal(recorded.ok, true);
    rmSync(leaseDir, { recursive: true, force: true });

    const swept = await sweep;

    assert.equal(swept.ok, true);
    if (!swept.ok) return;
    assert.deepEqual(swept.value.swept, []);
    assert.deepEqual(readFileSync(path.join(bytesRoot, artifactId)), bytes);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('orphan sweep reclaims stale final and temp publication leases', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-sweep-stale-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const priorRoot = process.env.NOVAKAI_ROOT;
  try {
    process.env.NVK_FAILPOINT = 'artifacts.put.before-record-append';
    const finalOrphan = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('stale final orphan bytes', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(finalOrphan.ok, false);
    if (finalOrphan.ok) return;
    const finalId = (
      finalOrphan.error.details as { artifactId: ArtifactId }
    ).artifactId;

    process.env.NVK_FAILPOINT = 'artifacts.put.after-temp-fsync';
    const tempOrphan = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
    }).operations.putArtifact({
      bytes: Buffer.from('stale temp orphan bytes', 'utf8'),
      mimeType: 'text/plain',
    }, mintClientOpId());
    assert.equal(tempOrphan.ok, false);
    if (tempOrphan.ok) return;
    const tempId = (
      tempOrphan.error.details as { artifactId: ArtifactId }
    ).artifactId;
    delete process.env.NVK_FAILPOINT;

    const locksRoot = path.join(
      root,
      'artifacts',
      '.publication-locks',
    );
    const finalLease = path.join(locksRoot, `${finalId}.lock`);
    mkdirSync(finalLease, { recursive: true });
    writeFileSync(
      path.join(finalLease, 'owner.json'),
      `${JSON.stringify({ pid: 999999, token: 'dead-owner' })}\n`,
    );
    const tempLease = path.join(locksRoot, `${tempId}.lock`);
    mkdirSync(tempLease);
    const staleAt = new Date(Date.now() - 60_000);
    utimesSync(tempLease, staleAt, staleAt);

    const swept = await composeArtifacts({
      root,
      principal: 'sys_reconciler',
      lockTimeoutMs: 100,
    }).boot.sweepOrphans();

    assert.equal(swept.ok, true);
    if (!swept.ok) return;
    assert.deepEqual(
      new Set(swept.value.swept.map((entry) => entry.entryType)),
      new Set(['final', 'temp']),
    );
    assert.deepEqual(readdirSync(path.join(root, 'artifacts')), []);

    process.env.NOVAKAI_ROOT = path.join(root, 'stores');
    __resetDefaultEngine();
    const traces = await queryTrace({});
    const sweepTraces = traces.items.filter(
      (trace) => trace.action === 'artifact.orphan.sweep',
    );
    assert.equal(sweepTraces.length, 2);
    assert.equal(
      sweepTraces.every((trace) =>
        JSON.stringify(trace.meta) === JSON.stringify({
          entryType: trace.meta?.entryType,
          status: 'accepted',
        })),
      true,
    );
    assert.equal(
      JSON.stringify(sweepTraces).includes('orphan bytes'),
      false,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    if (priorRoot === undefined) delete process.env.NOVAKAI_ROOT;
    else process.env.NOVAKAI_ROOT = priorRoot;
    __resetDefaultEngine();
    rmSync(workspace, { recursive: true, force: true });
  }
});

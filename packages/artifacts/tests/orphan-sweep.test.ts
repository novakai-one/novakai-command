import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  __resetDefaultEngine,
  mintClientOpId,
  queryTrace,
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

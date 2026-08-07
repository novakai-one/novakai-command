import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ClientOpId,
  ObjectId,
} from '../contract/brands.js';
import {
  composeHandle,
  getObject,
  isAbsent,
} from '../contract/index.js';
import { StoreEngine } from '../core/store-engine/engine.js';

const ROW_COUNT = 5_000;
const SAMPLE_COUNT = 5;
const READS_PER_SAMPLE = 10;
const READ_CREATED_AT = '2026-07-29T00:00:00.000Z';

function seedStore(root: string): void {
  const createdAt = '2026-07-29T00:00:00.000Z';
  const records = Array.from({ length: ROW_COUNT }, (_, index) => {
    const id = `settings_seed_${index}`;
    return JSON.stringify({
      envelope: {
        kind: 'settings',
        id,
        schemaVersion: 1,
        createdAt,
        permissionLevel: 'private',
        createdBy: 'person_fixture',
      },
      payload: { key: id, value: index },
      meta: {
        opId: `srv_seed_${index}`,
        clientOpId: `op_seed_${index}`,
        version: 1,
      },
    });
  });
  const traces = Array.from({ length: ROW_COUNT }, (_, index) =>
    JSON.stringify({
      kind: 'trace',
      id: `trace_seed_${index}`,
      schemaVersion: 1,
      createdAt,
      permissionLevel: 'team',
      createdBy: 'person_fixture',
      seq: index,
      opId: `srv_seed_${index}`,
      clientOpId: `op_seed_${index}`,
      action: 'create',
      target: { kind: 'settings', id: `settings_seed_${index}` },
    })
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'settings.jsonl'), `${records.join('\n')}\n`);
  writeFileSync(path.join(root, 'traces.jsonl'), `${traces.join('\n')}\n`);
}

function seedReadStore(root: string, tombstoneCount: number): void {
  const targetId = 'settings_read_target';
  const targetOpId = 'srv_read_target';
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'settings.jsonl'), `${JSON.stringify({
    envelope: {
      kind: 'settings',
      id: targetId,
      schemaVersion: 1,
      createdAt: READ_CREATED_AT,
      permissionLevel: 'private',
      createdBy: 'person_fixture',
    },
    payload: { key: targetId, value: 'visible' },
    meta: {
      opId: targetOpId,
      clientOpId: 'op_read_target',
      version: 1,
    },
  })}\n`);
  writeFileSync(path.join(root, 'traces.jsonl'), `${JSON.stringify({
    kind: 'trace',
    id: 'trace_read_target',
    schemaVersion: 1,
    createdAt: READ_CREATED_AT,
    permissionLevel: 'team',
    createdBy: 'person_fixture',
    seq: 0,
    opId: targetOpId,
    clientOpId: 'op_read_target',
    action: 'create',
    target: { kind: 'settings', id: targetId },
  })}\n`);
  if (tombstoneCount === 0) return;
  const tombstones = Array.from({ length: tombstoneCount }, (_, index) =>
    tombstoneLine(
      `quarantine_seed_${index}`,
      `settings_quarantined_${index}`,
      'open',
      1,
    )
  );
  writeFileSync(
    path.join(root, 'quarantine.jsonl'),
    `${tombstones.join('\n')}\n`,
  );
}

function tombstoneLine(
  id: string,
  refId: string,
  status: 'open' | 'dismissed',
  version: number,
): string {
  return JSON.stringify({
    envelope: {
      kind: 'quarantine',
      id,
      schemaVersion: 1,
      createdAt: READ_CREATED_AT,
      permissionLevel: 'private',
      createdBy: 'sys_reconciler',
    },
    payload: {
      quarantinedRef: { kind: 'settings', id: refId },
      reason: 'corrupt_record',
      status,
      ...(status === 'dismissed'
        ? {
          resolution: 'dismiss',
          resolvedAt: '2026-07-29T00:01:00.000Z',
          resolvedBy: 'person_fixture',
        }
        : {}),
    },
    meta: {
      opId: `srv_${id}_${version}`,
      clientOpId: `op_${id}_${version}`,
      version,
    },
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function appendSamples(root: string, prefix: string): number[] {
  const engine = new StoreEngine({ root });
  engine.boot();
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => {
    const id = `settings_${prefix}_${index}`;
    const startedAt = performance.now();
    const appended = engine.appendMutation(
      'settings',
      {
        kind: 'settings',
        id,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        permissionLevel: 'private',
        createdBy: 'person_fixture',
        key: id,
        value: index,
      },
      'create',
      `op_${prefix}_${index}` as ClientOpId,
      1,
      undefined,
      { mustBeAbsent: true },
    );
    const elapsed = performance.now() - startedAt;
    assert.equal(appended.ok, true);
    return elapsed;
  });
}

async function readSamples(root: string): Promise<number[]> {
  const handle = composeHandle({
    root,
    capability: 'foundation',
    allowedKinds: ['settings'],
    principal: 'person_fixture',
  });
  const targetId = 'settings_read_target' as ObjectId;
  const warm = await getObject(handle, 'settings', targetId);
  assert.equal(warm.ok, true);
  assert.equal(isAbsent(warm.value), false);

  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    for (let read = 0; read < READS_PER_SAMPLE; read += 1) {
      const result = await getObject(handle, 'settings', targetId);
      assert.equal(result.ok, true);
      assert.equal(isAbsent(result.value), false);
    }
    samples.push((performance.now() - startedAt) / READS_PER_SAMPLE);
  }
  return samples;
}

test('one append to a 5k-line store costs less than twice an empty-store append', (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-flat-append-'));
  const populatedRoot = path.join(workspace, 'populated');
  const emptyRoot = path.join(workspace, 'empty');
  try {
    seedStore(populatedRoot);
    const populatedMs = median(appendSamples(populatedRoot, 'populated'));
    const emptyMs = median(appendSamples(emptyRoot, 'empty'));
    t.diagnostic(
      `5k median ${populatedMs.toFixed(2)}ms; empty median `
      + `${emptyMs.toFixed(2)}ms; ratio `
      + `${(populatedMs / emptyMs).toFixed(2)}x`,
    );
    assert.ok(
      populatedMs < emptyMs * 2,
      `5k append ${populatedMs.toFixed(2)}ms must be <2x empty `
      + `${emptyMs.toFixed(2)}ms`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('getObject with 5k tombstones costs less than four times an empty-tombstone read', async (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-tombstone-read-'));
  const populatedRoot = path.join(workspace, 'populated');
  const emptyRoot = path.join(workspace, 'empty');
  try {
    seedReadStore(populatedRoot, ROW_COUNT);
    seedReadStore(emptyRoot, 0);
    const populatedMs = median(await readSamples(populatedRoot));
    const emptyMs = median(await readSamples(emptyRoot));
    t.diagnostic(
      `5k median ${populatedMs.toFixed(2)}ms; empty median `
      + `${emptyMs.toFixed(2)}ms; ratio `
      + `${(populatedMs / emptyMs).toFixed(2)}x`,
    );
    assert.ok(
      populatedMs < emptyMs * 4,
      `5k tombstone read ${populatedMs.toFixed(2)}ms must be <4x empty `
      + `${emptyMs.toFixed(2)}ms`,
    );

    const handle = composeHandle({
      root: populatedRoot,
      capability: 'foundation',
      allowedKinds: ['settings'],
      principal: 'person_fixture',
    });
    const targetId = 'settings_read_target' as ObjectId;
    const tombstoneId = 'quarantine_out_of_band';
    appendFileSync(
      path.join(populatedRoot, 'quarantine.jsonl'),
      `${tombstoneLine(tombstoneId, targetId, 'open', 1)}\n`,
    );
    const hidden = await getObject(handle, 'settings', targetId);
    assert.equal(hidden.ok, true);
    assert.equal(
      isAbsent(hidden.value),
      true,
      'an out-of-band open tombstone must become visible to the warm index',
    );

    appendFileSync(
      path.join(populatedRoot, 'quarantine.jsonl'),
      `${tombstoneLine(tombstoneId, targetId, 'dismissed', 2)}\n`,
    );
    const visible = await getObject(handle, 'settings', targetId);
    assert.equal(visible.ok, true);
    assert.equal(
      isAbsent(visible.value),
      false,
      'an out-of-band lifecycle update must reopen the object',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

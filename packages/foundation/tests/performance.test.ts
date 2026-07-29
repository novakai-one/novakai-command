import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ClientOpId,
} from '../contract/brands.js';
import { StoreEngine } from '../core/store-engine/engine.js';

const ROW_COUNT = 5_000;
const SAMPLE_COUNT = 5;

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

test('one append to a 5k-line store costs less than twice an empty-store append', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-flat-append-'));
  const populatedRoot = path.join(workspace, 'populated');
  const emptyRoot = path.join(workspace, 'empty');
  try {
    seedStore(populatedRoot);
    const populatedMs = median(appendSamples(populatedRoot, 'populated'));
    const emptyMs = median(appendSamples(emptyRoot, 'empty'));
    assert.ok(
      populatedMs < emptyMs * 2,
      `5k append ${populatedMs.toFixed(2)}ms must be <2x empty `
      + `${emptyMs.toFixed(2)}ms`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

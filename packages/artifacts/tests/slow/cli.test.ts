import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  mintClientOpId,
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';

// Source lives at tests/slow/, compiled output at dist/tests/slow/ — the
// depth differs, so resolve the package root by walking up to tsconfig.json.
const packageRoot = (() => {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (!existsSync(path.join(dir, 'tsconfig.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root not found from ${dir}`);
    dir = parent;
  }
  return dir;
})();

// The CLI is the COMPILED entry point: requires `npm run build` first (slow
// tier only).
const cli = path.join(packageRoot, 'dist', 'cli', 'nvk-artifact.js');

function invoke(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
}

function invokeBytes(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args]);
}

test('offline CLI put derives the artifact principal from bearer auth', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-cli-put-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'evidence.bin');
  try {
    const bytes = Buffer.from([0, 12, 24, 36, 48, 255]);
    writeFileSync(source, bytes);
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );

    const result = invoke([
      'put',
      source,
      '--root', root,
      '--token', token.bearer,
      '--mime-type', 'application/octet-stream',
      '--client-op-id', mintClientOpId(),
    ]);

    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(result.stdout) as {
      id: string;
      createdBy: string;
      byteSize: number;
    };
    assert.equal(artifact.createdBy, 'person_cli');
    assert.equal(artifact.byteSize, bytes.byteLength);
    assert.deepEqual(
      readFileSync(path.join(root, 'artifacts', artifact.id)),
      bytes,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('offline CLI get-meta matches put metadata', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-cli-meta-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'meta.txt');
  try {
    writeFileSync(source, 'metadata parity');
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );
    const put = invoke([
      'put',
      source,
      '--root', root,
      '--token', token.bearer,
      '--mime-type', 'text/plain',
      '--client-op-id', mintClientOpId(),
    ]);
    assert.equal(put.status, 0, put.stderr);
    const artifact = JSON.parse(put.stdout) as { id: string };

    const found = invoke([
      'get-meta',
      artifact.id,
      '--root', root,
      '--token', token.bearer,
    ]);

    assert.equal(found.status, 0, found.stderr);
    assert.deepEqual(JSON.parse(found.stdout), JSON.parse(put.stdout));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('offline CLI list returns the same metadata collection', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-cli-list-'));
  const root = path.join(workspace, '.novakai');
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );
    const putResults: Array<{ id: string }> = [];
    for (const name of ['one.txt', 'two.txt']) {
      const source = path.join(workspace, name);
      writeFileSync(source, name);
      const put = invoke([
        'put',
        source,
        '--root', root,
        '--token', token.bearer,
        '--mime-type', 'text/plain',
        '--client-op-id', mintClientOpId(),
      ]);
      assert.equal(put.status, 0, put.stderr);
      putResults.push(JSON.parse(put.stdout) as { id: string });
    }

    const listed = invoke([
      'list',
      '--root', root,
      '--token', token.bearer,
    ]);

    assert.equal(listed.status, 0, listed.stderr);
    const page = JSON.parse(listed.stdout) as {
      items: Array<{ id: string; bytes?: unknown }>;
    };
    assert.deepEqual(
      new Set(page.items.map((artifact) => artifact.id)),
      new Set(putResults.map((artifact) => artifact.id)),
    );
    assert.equal(
      page.items.every((artifact) => artifact.bytes === undefined),
      true,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('offline CLI get-bytes returns the exact binary payload', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-cli-bytes-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'binary.dat');
  try {
    const bytes = Buffer.from([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    writeFileSync(source, bytes);
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );
    const put = invoke([
      'put',
      source,
      '--root', root,
      '--token', token.bearer,
      '--client-op-id', mintClientOpId(),
    ]);
    assert.equal(put.status, 0, put.stderr);
    const artifact = JSON.parse(put.stdout) as { id: string };

    const found = invokeBytes([
      'get-bytes',
      artifact.id,
      '--root', root,
      '--token', token.bearer,
    ]);

    assert.equal(found.status, 0, found.stderr.toString('utf8'));
    assert.deepEqual(found.stdout, bytes);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('offline CLI contends on the same Foundation global lock after byte durability', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifact-cli-lock-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'locked.txt');
  try {
    const bytes = Buffer.from('durable before CLI lock failure', 'utf8');
    writeFileSync(source, bytes);
    const token = mintToken(
      root,
      'person_cli',
      ['artifact'],
      'sys_spine',
    );
    const lockDir = path.join(root, 'lock');
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'cli-test-holder' })}\n`,
    );

    const startedAt = Date.now();
    const result = invoke([
      'put',
      source,
      '--root', root,
      '--token', token.bearer,
      '--client-op-id', mintClientOpId(),
      '--lock-timeout-ms', '50',
    ]);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'LockBusy');
    assert.equal(
      elapsedMs < 1_000,
      true,
      `--lock-timeout-ms was ignored (elapsed ${elapsedMs}ms)`,
    );
    const byteFiles = readdirSync(path.join(root, 'artifacts'));
    assert.equal(byteFiles.length, 1);
    assert.deepEqual(
      readFileSync(path.join(root, 'artifacts', byteFiles[0])),
      bytes,
    );
    assert.equal(existsSync(path.join(root, 'artifacts.jsonl')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

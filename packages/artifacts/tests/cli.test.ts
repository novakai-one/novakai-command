import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
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

const cli = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../cli/nvk-artifact.js',
);

function invoke(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
  });
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

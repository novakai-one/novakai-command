import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';

const CLI = path.resolve('../../scripts/nvk.mjs');

function invoke(
  root: string,
  token: string,
  args: string[],
) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_ROOT: root,
      NOVAKAI_TOKEN: token,
    },
  });
}

test('nvk dispatches the project and artifact offline command groups', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-umbrella-'));
  const root = path.join(workspace, '.novakai');
  const source = path.join(workspace, 'evidence.bin');
  try {
    const bytes = Buffer.from([0, 255, 17, 34, 51]);
    writeFileSync(source, bytes);
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem', 'artifact'],
      'person_local',
    );

    const project = invoke(root, token.bearer, [
      'project',
      'create',
      '--title', 'Umbrella Project',
      '--client-op-id', 'op_umbrella_project',
    ]);
    assert.equal(project.status, 0, project.stderr);
    assert.match(
      (JSON.parse(project.stdout) as { id: string }).id,
      /^proj_/,
    );

    const artifact = invoke(root, token.bearer, [
      'artifact',
      'put',
      source,
      '--client-op-id', 'op_umbrella_artifact',
    ]);
    assert.equal(artifact.status, 0, artifact.stderr);
    assert.equal(
      (JSON.parse(artifact.stdout) as { byteSize: number }).byteSize,
      bytes.byteLength,
    );

    const bypass = invoke(root, token.bearer, [
      'project',
      'attach',
      '--project', 'proj_bypass',
      '--client-op-id', 'op_bypass',
    ]);
    assert.equal(bypass.status, 1);
    assert.equal(JSON.parse(bypass.stderr).code, 'Usage');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('nvk rejects inherited object names through the typed Usage path', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-umbrella-inherited-'));
  const root = path.join(workspace, '.novakai');
  try {
    const inherited = invoke(root, 'unused-token', ['constructor']);

    assert.equal(inherited.status, 2);
    assert.deepEqual(JSON.parse(inherited.stderr), {
      code: 'Usage',
      message: 'usage: nvk deploy|project|artifact|agent|child|runtime|terminal|watch '
        + '<verb> [options]',
    });
    assert.doesNotMatch(inherited.stderr, /TypeError|ERR_INVALID_ARG_TYPE|\n\s+at /);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('nvk mutations retain contention on the global Foundation lock', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-umbrella-lock-'));
  const root = path.join(workspace, '.novakai');
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    const lockDir = path.join(root, 'lock');
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'umbrella-holder' })}\n`,
    );
    const blocked = invoke(root, token.bearer, [
      'project',
      'create',
      '--title', 'Blocked',
      '--client-op-id', 'op_umbrella_blocked',
      '--lock-timeout-ms', '50',
    ]);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stderr).code, 'LockBusy');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

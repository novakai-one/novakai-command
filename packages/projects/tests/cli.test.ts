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
  mintClientOpId,
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';

const CLI = path.resolve('dist/cli/nvk-project.js');

function invoke(root: string, args: string[], token?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_ROOT: root,
      NOVAKAI_TOKEN: token ?? '',
    },
  });
}

test('offline CLI requires a recognized bearer token', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-auth-'));
  try {
    const noToken = invoke(root, ['list']);
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /token/i);

    const wrongToken = invoke(root, ['list'], 'nvk_wrong');
    assert.equal(wrongToken.status, 1);
    assert.equal(JSON.parse(wrongToken.stderr).code, 'AuthFailed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI create preserves the shared Foundation lock failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-lock-'));
  const lockDir = path.join(root, 'lock');
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'cli-test-holder' })}\n`,
    );
    const blocked = invoke(root, [
      'create',
      '--title', 'Blocked by global lock',
      '--client-op-id', mintClientOpId(),
      '--lock-timeout-ms', '50',
    ], token.bearer);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stderr).code, 'LockBusy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

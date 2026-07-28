import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../..',
);

test('package exports expose only the Artifacts contract root and hide private core', () => {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, unknown> };

  assert.equal(existsSync(path.join(packageRoot, 'core', 'artifacts.ts')), true);
  assert.deepEqual(Object.keys(packageJson.exports ?? {}), ['.']);
});

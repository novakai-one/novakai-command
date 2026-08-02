import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function contractSources(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return contractSources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  }));
  return nested.flat();
}

test('package exposes only the frozen contract door and its testkit door', async () => {
  const manifest = JSON.parse(
    await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
  ) as { exports?: Readonly<Record<string, unknown>> };
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [
    './contract',
    './contract/testkit',
  ]);
});

test('contract sources import no other capability private path', async () => {
  const files = await contractSources(join(PACKAGE_ROOT, 'contract'));
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const capabilityImports = source.matchAll(/from ['"](@novakai\/[^'"]+)['"]/g);
    for (const match of capabilityImports) {
      assert.equal(match[1], '@novakai/foundation/contract', file);
    }
  }
});

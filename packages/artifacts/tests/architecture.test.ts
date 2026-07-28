import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as artifactsPackage from '../contract/index.js';

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

test('public composition exposes opaque least-authority host views', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-artifacts-host-'));
  try {
    const host = artifactsPackage.composeArtifacts({
      root: path.join(workspace, '.novakai'),
      principal: 'person_chris',
    });

    assert.deepEqual(
      Object.keys(host).sort(),
      ['boot', 'http', 'operations'],
    );
    assert.deepEqual(
      Object.keys(host.operations).sort(),
      ['getArtifactMeta', 'listArtifacts', 'putArtifact'],
    );
    assert.deepEqual(Object.keys(host.http), ['getArtifactBytes']);
    assert.deepEqual(Object.keys(host.boot), ['sweepOrphans']);
    assert.equal('handle' in host, false);
    assert.equal('root' in host, false);
    assert.equal('bytesRoot' in host, false);
    assert.equal('createArtifactsContract' in artifactsPackage, false);

    const declaration = readFileSync(
      path.join(packageRoot, 'dist', 'contract', 'index.d.ts'),
      'utf8',
    );
    assert.equal(declaration.includes('ArtifactsContext'), false);
    assert.equal(declaration.includes('ScopedStoreHandle'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

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
import * as projectsPackage from '../contract/index.js';

// Source lives at tests/, compiled output at dist/tests/ — the depth
// differs, so resolve the package root by walking up to tsconfig.json.
const packageRoot = (() => {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (!existsSync(path.join(dir, 'tsconfig.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package root not found from ${dir}`);
    dir = parent;
  }
  return dir;
})();

test('package root exposes the public contract and seals private core paths', async () => {
  const packageRoot = '@novakai/projects';
  const publicContract = await import(packageRoot);
  assert.equal(typeof publicContract.composeProjects, 'function');

  const privateCore = '@novakai/projects/core/projects.js';
  await assert.rejects(
    import(privateCore),
    (error: unknown) => {
      assert.equal(
        (error as NodeJS.ErrnoException).code,
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
      );
      return true;
    },
  );
});

test('public composition exposes only opaque Projects consumer views', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-projects-host-'));
  try {
    const host = projectsPackage.composeProjects({
      root: path.join(workspace, '.novakai'),
      principal: 'person_chris',
    });

    assert.deepEqual(Object.keys(host).sort(), ['operations', 'spine']);
    assert.deepEqual(
      Object.keys(host.operations).sort(),
      ['archiveProject', 'createProject', 'getProjectItems', 'listProjects'],
    );
    assert.deepEqual(
      Object.keys(host.spine).sort(),
      [
        'archiveProject',
        'attach',
        'createProject',
        'getProjectItems',
        'listProjects',
      ],
    );
    assert.equal('handle' in host, false);
    assert.equal('principal' in host, false);
    assert.equal('root' in host, false);
    assert.equal('createProjectsContract' in projectsPackage, false);
    assert.equal('createSpineProjectsContract' in projectsPackage, false);

    const declaration = readFileSync(
      path.join(packageRoot, 'dist', 'contract', 'index.d.ts'),
      'utf8',
    );
    assert.equal(declaration.includes('ProjectsContext'), false);
    assert.equal(declaration.includes('ScopedStoreHandle'), false);
    assert.equal(declaration.includes('createProjectsContract'), false);
    assert.equal(declaration.includes('createSpineProjectsContract'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

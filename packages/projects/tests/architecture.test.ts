import test from 'node:test';
import assert from 'node:assert/strict';

test('package root exposes the public contract and seals private core paths', async () => {
  const packageRoot = '@novakai/projects';
  const publicContract = await import(packageRoot);
  assert.equal(typeof publicContract.composeProjects, 'function');
  assert.equal(typeof publicContract.createProjectsContract, 'function');
  assert.equal(typeof publicContract.createSpineProjectsContract, 'function');

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

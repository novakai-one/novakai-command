import test from 'node:test';
import assert from 'node:assert/strict';
import * as spinePackage from '@novakai/spine';
import { composeSpine } from '../contract/index.js';

test('package exports an opaque Spine host and rejects every private core subpath', async () => {
  assert.equal(typeof spinePackage.composeSpine, 'function');
  assert.equal('createSpineHost' in spinePackage, false);
  assert.equal('resumeWorkflow' in spinePackage, false);
  assert.equal('SpineContext' in spinePackage, false);

  const privateSubpath: string = '@novakai/spine/core/workflows.js';
  await assert.rejects(
    import(privateSubpath),
    (error: unknown) =>
      error instanceof Error
      && (error as NodeJS.ErrnoException).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );

  const host = composeSpine({
    root: '.novakai-never-opened-by-boundary-test',
    principal: 'sys_spine',
    messaging: {
      async getDelivery() {
        return assert.fail('boundary test must not execute dependencies');
      },
    },
    artifacts: {
      async getArtifactMeta() {
        return assert.fail('boundary test must not execute dependencies');
      },
    },
    projects: {
      async attach() {
        return assert.fail('boundary test must not execute dependencies');
      },
    },
  });
  assert.deepEqual(Object.keys(host).sort(), ['boot', 'operations']);
  assert.deepEqual(Object.keys(host.boot), ['scanWorkflows']);
  assert.deepEqual(Object.keys(host.operations).sort(), [
    'abandonWorkflow',
    'addMessageToProject',
    'attachArtifactToProject',
    'continueWorkflow',
    'getSpineWorkflows',
  ]);
});

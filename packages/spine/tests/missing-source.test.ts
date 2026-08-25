import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ABSENT,
  mintClientOpId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  MessagingError,
} from '@novakai/messaging';
import { composeProjects } from '@novakai/projects';
import { composeSpine } from '../contract/index.js';

test('missing Message and Artifact sources become typed failed workflows without Project items', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-missing-'));
  const root = path.join(workspace, '.novakai');
  try {
    const projects = composeProjects({
      root,
      principal: 'sys_spine',
    });
    const project = await projects.operations.createProject(
      { title: 'No dangling source from Spine' },
      mintClientOpId(),
    );
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      projects: projects.spine,
      messaging: {
        async getDelivery(input) {
          return {
            kind: 'error',
            error: new MessagingError('UnknownMessage', {
              fields: {
                messageId: (input as { messageId: string }).messageId,
              },
            }),
          };
        },
      },
      artifacts: {
        async getArtifactMeta(artifactId) {
          return {
            ok: true,
            value: ABSENT({ kind: 'artifact', id: artifactId }),
          };
        },
      },
    });

    const message = await spine.operations.addMessageToProject({
      messageId: 'message_missing' as never,
      projectId: project.value.id,
    }, 'op_missing_message' as never);
    assert.equal(message.ok, false);
    assert.equal(
      message.ok ? null : message.error.code,
      'SpineSourceMissing',
    );

    const artifact = await spine.operations.attachArtifactToProject({
      artifactId: 'artifact_missing' as never,
      projectId: project.value.id,
    }, 'op_missing_artifact' as never);
    assert.equal(artifact.ok, false);
    assert.equal(
      artifact.ok ? null : artifact.error.code,
      'SpineSourceMissing',
    );

    const workflows = await spine.operations.getSpineWorkflows();
    assert.equal(workflows.ok, true);
    if (!workflows.ok) return;
    assert.deepEqual(
      workflows.value.items.map(({ state }) => state),
      ['failed', 'failed'],
    );

    const items = await projects.operations.getProjectItems(project.value.id);
    assert.equal(items.ok, true);
    assert.deepEqual(items.ok ? items.value.items : null, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

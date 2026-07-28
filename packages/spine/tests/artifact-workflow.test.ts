import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ArtifactId,
  ClientOpId,
  ProjectId,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeSpine,
  type SpineHost,
} from '../contract/index.js';

test('artifact workflow accepts before effects and journals refs without artifact content', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-artifact-'));
  const root = path.join(workspace, '.novakai');
  const originalClientOpId = 'op_artifact_workflow' as ClientOpId;
  const artifactId = 'artifact_existing' as ArtifactId;
  const projectId = 'proj_target' as ProjectId;
  const observations: string[] = [];
  let host: SpineHost;

  try {
    host = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          return assert.fail('messaging dependency must not be called');
        },
      },
      artifacts: {
        async getArtifactMeta(receivedArtifactId) {
          const workflows = await host.operations.getSpineWorkflows();
          if (!workflows.ok) return assert.fail(workflows.error.message);
          assert.equal(workflows.value.items[0]?.state, 'running');
          assert.equal(workflows.value.items[0]?.steps[0]?.state, 'running');
          observations.push(`artifact:${String(receivedArtifactId)}`);
          return {
            ok: true,
            value: {
              kind: 'artifact',
              id: receivedArtifactId,
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              permissionLevel: 'team',
              createdBy: 'person_chris',
              mimeType: 'application/x-secret-domain-content',
              byteSize: 999,
              originPath: '/must/not/enter/spine',
            },
          };
        },
      },
      projects: {
        async attach(receivedProjectId, input, clientOpId) {
          const workflows = await host.operations.getSpineWorkflows();
          if (!workflows.ok) return assert.fail(workflows.error.message);
          assert.equal(workflows.value.items[0]?.steps[0]?.state, 'done');
          assert.equal(workflows.value.items[0]?.steps[1]?.state, 'running');
          observations.push(`attach:${String(clientOpId)}`);
          return {
            ok: true,
            value: {
              kind: 'projectItem',
              id: 'projectItem_artifact',
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              permissionLevel: 'team',
              createdBy: 'sys_spine',
              projectId: receivedProjectId,
              itemRef: input.itemRef,
              ...(input.note === undefined ? {} : { note: input.note }),
              addedBy: 'sys_spine',
              addedVia: 'spine',
            },
          };
        },
      },
    });

    const result = await host.operations.attachArtifactToProject({
      artifactId,
      projectId,
      note: 'Artifact ref only',
    }, originalClientOpId);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.state, 'done');
    assert.deepEqual(result.value.sourceRef, {
      kind: 'artifact',
      id: artifactId,
    });
    assert.deepEqual(
      result.value.steps.map(({ effectOpId, state }) => ({ effectOpId, state })),
      [
        { effectOpId: 'op_artifact_workflow:step:1', state: 'done' },
        { effectOpId: 'op_artifact_workflow:step:2', state: 'done' },
      ],
    );
    assert.deepEqual(observations, [
      'artifact:artifact_existing',
      'attach:op_artifact_workflow:step:2',
    ]);
    const journal = readFileSync(
      path.join(root, 'stores', 'spineSteps.jsonl'),
      'utf8',
    );
    assert.equal(journal.includes('application/x-secret-domain-content'), false);
    assert.equal(journal.includes('/must/not/enter/spine'), false);
    assert.equal(journal.includes('"byteSize":999'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { composeProjects } from '@novakai/projects';
import {
  composeSpine,
  type ComposeSpineOptions,
} from '../contract/index.js';

test('artifact continuation is durable and retries by its own caller clientOpId', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-continue-op-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    const projects = composeProjects({ root, principal: 'sys_spine' });
    const project = await projects.operations.createProject(
      { title: 'Artifact recovery' },
      mintClientOpId(),
    );
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const dependencies: Pick<
      ComposeSpineOptions,
      'messaging' | 'projects' | 'artifacts'
    > = {
      messaging: {
        async getDelivery() {
          return assert.fail('message dependency must not be called');
        },
      },
      projects: projects.spine,
      artifacts: {
        async getArtifactMeta(artifactId) {
          return {
            ok: true,
            value: {
              kind: 'artifact',
              id: artifactId,
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              permissionLevel: 'team',
              createdBy: 'person_chris',
              mimeType: 'text/plain',
              byteSize: 4,
            },
          };
        },
      },
    };

    process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
    const interruptedHost = composeSpine({
      root,
      principal: 'sys_spine',
      ...dependencies,
    });
    delete process.env.NVK_FAILPOINT;
    const interrupted = await interruptedHost.operations.attachArtifactToProject({
      artifactId: 'artifact_recoverable' as never,
      projectId: project.value.id,
    }, 'op_artifact_recoverable' as never);
    assert.equal(interrupted.ok, false);

    const freshHost = composeSpine({
      root,
      principal: 'sys_spine',
      ...dependencies,
    });
    const scan = await freshHost.boot.scanWorkflows();
    assert.equal(scan.ok, true);
    if (!scan.ok) return;
    const workflowId = scan.value.items[0]!.workflowId;
    const continueClientOpId = 'op_continue_artifact' as never;

    const first = await freshHost.operations.continueWorkflow(
      workflowId,
      continueClientOpId,
    );
    const retry = await freshHost.operations.continueWorkflow(
      workflowId,
      continueClientOpId,
    );

    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    if (!first.ok || !retry.ok) return;
    assert.equal(first.value.state, 'done');
    assert.equal(retry.value.workflowId, first.value.workflowId);
    assert.equal(retry.value.state, 'done');
    const items = await projects.operations.getProjectItems(project.value.id);
    assert.equal(items.ok, true);
    assert.equal(items.ok ? items.value.items.length : -1, 1);
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

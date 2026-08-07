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

test('fresh composition discovers interrupted workflows and continuation converges across effect boundaries', async () => {
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const scenarios = [
    {
      point: 'spine.journal.accepted.after',
      expectedMessageCallsBeforeContinue: 0,
      expectedItemsBeforeContinue: 0,
    },
    {
      point: 'spine.effect.step1.after',
      expectedMessageCallsBeforeContinue: 1,
      expectedItemsBeforeContinue: 0,
    },
    {
      point: 'spine.effect.step2.after',
      expectedMessageCallsBeforeContinue: 1,
      expectedItemsBeforeContinue: 1,
    },
  ] as const;

  try {
    for (const scenario of scenarios) {
      const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-recovery-'));
      const root = path.join(workspace, '.novakai');
      let messageCalls = 0;
      try {
        const projects = composeProjects({ root, principal: 'sys_spine' });
        const project = await projects.operations.createProject(
          { title: scenario.point },
          mintClientOpId(),
        );
        assert.equal(project.ok, true);
        if (!project.ok) continue;

        const dependencies: Pick<
          ComposeSpineOptions,
          'messaging' | 'projects' | 'artifacts'
        > = {
          messaging: {
            async getDelivery() {
              messageCalls += 1;
              return { kind: 'ok', value: { deliveries: [] } };
            },
          },
          projects: projects.spine,
          artifacts: {
            async getArtifactMeta() {
              return assert.fail('artifact dependency must not be called');
            },
          },
        };

        process.env.NVK_FAILPOINT = scenario.point;
        const interruptedHost = composeSpine({
          root,
          principal: 'sys_spine',
          ...dependencies,
        });
        delete process.env.NVK_FAILPOINT;
        const interrupted = await interruptedHost.operations.addMessageToProject({
          messageId: 'message_recovery' as never,
          projectId: project.value.id,
        }, `op_${scenario.point}` as never);
        assert.equal(interrupted.ok, false, scenario.point);
        assert.equal(
          interrupted.ok ? null : interrupted.error.code,
          'SpineFailpoint',
          scenario.point,
        );
        assert.equal(
          messageCalls,
          scenario.expectedMessageCallsBeforeContinue,
          scenario.point,
        );

        const beforeItems = await projects.operations.getProjectItems(
          project.value.id,
        );
        assert.equal(beforeItems.ok, true);
        assert.equal(
          beforeItems.ok ? beforeItems.value.items.length : -1,
          scenario.expectedItemsBeforeContinue,
          scenario.point,
        );

        const freshHost = composeSpine({
          root,
          principal: 'sys_spine',
          ...dependencies,
        });
        const discovered = await freshHost.boot.scanWorkflows();
        assert.equal(discovered.ok, true);
        if (!discovered.ok) continue;
        assert.equal(discovered.value.items.length, 1, scenario.point);
        assert.equal(discovered.value.items[0]?.resumable, true, scenario.point);

        const continued = await freshHost.operations.continueWorkflow(
          discovered.value.items[0]!.workflowId,
          `op_continue_${scenario.point}` as never,
        );
        assert.equal(continued.ok, true, scenario.point);
        assert.equal(continued.ok ? continued.value.state : null, 'done');

        const afterItems = await projects.operations.getProjectItems(
          project.value.id,
        );
        assert.equal(afterItems.ok, true);
        assert.equal(
          afterItems.ok ? afterItems.value.items.length : -1,
          1,
          `${scenario.point}: step 2 retry uses the original effect id`,
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
  }
});

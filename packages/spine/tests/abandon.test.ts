import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeSpine } from '../contract/index.js';

test('abandon appends a terminal tombstone and abandoned workflows refuse continuation', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-abandon-'));
  const root = path.join(workspace, '.novakai');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  let effects = 0;
  try {
    const dependencies = {
      messaging: {
        async getDelivery() {
          effects += 1;
          return { kind: 'ok' as const, value: { deliveries: [] } };
        },
      },
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('artifact dependency must not be called');
        },
      },
      projects: {
        async attach() {
          effects += 1;
          return assert.fail('project attach must not be called');
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
    const interrupted = await interruptedHost.operations.addMessageToProject({
      messageId: 'message_abandon' as never,
      projectId: 'proj_abandon' as never,
    }, 'op_abandon_workflow' as never);
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

    const abandoned = await freshHost.operations.abandonWorkflow(
      workflowId,
      'op_abandon_command' as never,
    );
    const retry = await freshHost.operations.abandonWorkflow(
      workflowId,
      'op_abandon_command' as never,
    );
    assert.equal(abandoned.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(abandoned.ok ? abandoned.value.state : null, 'abandoned');
    assert.equal(retry.ok ? retry.value.state : null, 'abandoned');
    assert.equal(effects, 0);

    const afterScan = await freshHost.boot.scanWorkflows();
    assert.equal(afterScan.ok, true);
    assert.deepEqual(afterScan.ok ? afterScan.value.items : null, []);

    const continued = await freshHost.operations.continueWorkflow(
      workflowId,
      'op_continue_abandoned' as never,
    );
    assert.equal(continued.ok, false);
    assert.equal(
      continued.ok ? null : continued.error.code,
      'SpineWorkflowNotContinuable',
    );

    const all = await freshHost.operations.getSpineWorkflows();
    assert.equal(all.ok, true);
    assert.equal(all.ok ? all.value.items[0]?.state : null, 'abandoned');
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

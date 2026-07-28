import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ClientOpId,
  ProjectId,
} from '@novakai/foundation/dist/contract/index.js';
import type { MessageId } from '@novakai/messaging/dist/public/index.js';
import {
  composeSpine,
  type SpineHost,
} from '../contract/index.js';

test('message workflow accepts before effects and carries exact step identities', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-message-'));
  const root = path.join(workspace, '.novakai');
  const originalClientOpId = 'op_message_workflow' as ClientOpId;
  const messageId = 'message_existing' as MessageId;
  const projectId = 'proj_target' as ProjectId;
  const observations: string[] = [];
  let host: SpineHost;

  try {
    host = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery(input) {
          const workflows = await host.operations.getSpineWorkflows();
          assert.equal(workflows.ok, true);
          if (!workflows.ok) return assert.fail(workflows.error.message);
          assert.equal(workflows.value.items[0]?.state, 'accepted');
          observations.push(`message:${String((input as { messageId: string }).messageId)}`);
          return { kind: 'ok', value: { deliveries: [] } };
        },
      },
      projects: {
        async attach(receivedProjectId, input, clientOpId) {
          const workflows = await host.operations.getSpineWorkflows();
          assert.equal(workflows.ok, true);
          if (!workflows.ok) return assert.fail(workflows.error.message);
          assert.equal(workflows.value.items[0]?.steps[0]?.state, 'done');
          assert.equal(workflows.value.items[0]?.steps[1]?.state, 'running');
          observations.push(`attach:${String(clientOpId)}`);
          return {
            ok: true,
            value: {
              kind: 'projectItem',
              id: 'projectItem_message',
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
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('artifact dependency must not be called');
        },
      },
    });

    const result = await host.operations.addMessageToProject({
      messageId,
      projectId,
      note: 'Source, not a copy',
    }, originalClientOpId);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.state, 'done');
    assert.deepEqual(
      result.value.steps.map(({ effectOpId, state }) => ({ effectOpId, state })),
      [
        { effectOpId: 'op_message_workflow:step:1', state: 'done' },
        { effectOpId: 'op_message_workflow:step:2', state: 'done' },
      ],
    );
    assert.deepEqual(observations, [
      'message:message_existing',
      'attach:op_message_workflow:step:2',
    ]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

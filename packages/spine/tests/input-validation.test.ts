import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeSpine } from '../contract/index.js';

test('workflow creation rejects malformed runtime input as typed data before journaling or effects', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-input-'));
  const root = path.join(workspace, '.novakai');
  let effects = 0;
  try {
    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          effects += 1;
          return { kind: 'ok', value: { deliveries: [] } };
        },
      },
      artifacts: {
        async getArtifactMeta() {
          effects += 1;
          return assert.fail('invalid input must not reach Artifacts');
        },
      },
      projects: {
        async attach() {
          effects += 1;
          return assert.fail('invalid input must not reach Projects');
        },
      },
    });

    const malformedInput = await spine.operations.addMessageToProject({
      messageId: 'not-a-message-id',
      projectId: 'not-a-project-id',
      note: '',
    } as never, 'op_invalid_input' as never);
    assert.equal(malformedInput.ok, false);
    assert.equal(
      malformedInput.ok ? null : malformedInput.error.code,
      'InvalidEnvelope',
    );
    assert.deepEqual(
      malformedInput.ok || malformedInput.error.code !== 'InvalidEnvelope'
        ? []
        : malformedInput.error.details.invalidFields.map(({ field }) => field),
      ['messageId', 'projectId', 'note'],
    );

    const missingOperationId =
      await spine.operations.attachArtifactToProject({
        artifactId: 'artifact_valid_shape' as never,
        projectId: 'proj_valid_shape' as never,
      }, '' as never);
    assert.equal(missingOperationId.ok, false);
    assert.equal(
      missingOperationId.ok ? null : missingOperationId.error.code,
      'InvalidEnvelope',
    );
    assert.deepEqual(
      missingOperationId.ok
      || missingOperationId.error.code !== 'InvalidEnvelope'
        ? []
        : missingOperationId.error.details.missingFields,
      ['clientOpId'],
    );

    assert.equal(effects, 0);
    assert.equal(
      existsSync(path.join(root, 'stores', 'spineSteps.jsonl')),
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

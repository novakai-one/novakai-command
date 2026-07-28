import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeSpine,
  type ComposeSpineOptions,
} from '../contract/index.js';

type SourceKind = 'message' | 'artifact';
type CommandKind = 'continue' | 'abandon';

function host(root: string) {
  const dependencies: Pick<
    ComposeSpineOptions,
    'messaging' | 'projects' | 'artifacts'
  > = {
    messaging: {
      async getDelivery() {
        return { kind: 'ok', value: { deliveries: [] } };
      },
    },
    projects: {
      async attach(projectId, input) {
        return {
          ok: true,
          value: {
            kind: 'projectItem',
            id: `projectItem_${input.itemRef.id}`,
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            permissionLevel: 'team',
            createdBy: 'sys_spine',
            projectId,
            itemRef: input.itemRef,
            addedBy: 'sys_spine',
            addedVia: 'spine',
          },
        };
      },
    },
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
            createdBy: 'sys_spine',
            mimeType: 'text/plain',
            byteSize: 1,
          },
        };
      },
    },
  };
  return composeSpine({
    root,
    principal: 'sys_spine',
    ...dependencies,
  });
}

function startWorkflow(
  root: string,
  sourceKind: SourceKind,
  clientOpId: string,
) {
  const spine = host(root);
  return sourceKind === 'message'
    ? spine.operations.addMessageToProject({
        messageId: `message_${clientOpId}` as never,
        projectId: `proj_${clientOpId}` as never,
      }, clientOpId as never)
    : spine.operations.attachArtifactToProject({
        artifactId: `artifact_${clientOpId}` as never,
        projectId: `proj_${clientOpId}` as never,
      }, clientOpId as never);
}

async function acceptedWorkflow(root: string, clientOpId: string) {
  process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
  const interrupted = await startWorkflow(root, 'message', clientOpId);
  delete process.env.NVK_FAILPOINT;
  assert.equal(interrupted.ok, false);
  const workflows = await host(root).operations.getSpineWorkflows();
  if (!workflows.ok) return assert.fail(workflows.error.message);
  const workflow = workflows.value.items.find(
    (candidate) => candidate.originalClientOpId === clientOpId,
  );
  assert.ok(workflow);
  return workflow.workflowId;
}

function runCommand(
  root: string,
  commandKind: CommandKind,
  workflowId: Awaited<ReturnType<typeof acceptedWorkflow>>,
  clientOpId: string,
) {
  const spine = host(root);
  return commandKind === 'continue'
    ? spine.operations.continueWorkflow(
        workflowId,
        clientOpId as never,
      )
    : spine.operations.abandonWorkflow(
        workflowId,
        clientOpId as never,
      );
}

function journalSnapshot(root: string) {
  const content = readFileSync(
    path.join(root, 'stores', 'spineSteps.jsonl'),
    'utf8',
  );
  return {
    content,
    count: content.trim().length === 0
      ? 0
      : content.trimEnd().split('\n').length,
  };
}

function assertState(
  result: Awaited<ReturnType<typeof startWorkflow>>,
  state: 'done' | 'abandoned',
) {
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.value.state : null, state);
}

for (const sourceKind of ['message', 'artifact'] as const) {
  for (const commandKind of ['continue', 'abandon'] as const) {
    test(`${sourceKind} acceptance cannot steal a cross-workflow ${commandKind} command ID`, async () => {
      const workspace = mkdtempSync(
        path.join(
          tmpdir(),
          `nvk-spine-${sourceKind}-${commandKind}-reservation-`,
        ),
      );
      const root = path.join(workspace, '.novakai');
      const priorFailpoint = process.env.NVK_FAILPOINT;
      try {
        const prospectiveOpId =
          `op_${sourceKind}_${commandKind}_prospective`;
        const durableCommandId =
          `${prospectiveOpId}:journal:step:1:done`;
        const existingWorkflowId = await acceptedWorkflow(
          root,
          `op_${sourceKind}_${commandKind}_existing`,
        );
        const expectedState = commandKind === 'continue'
          ? 'done'
          : 'abandoned';
        const acceptedCommand = await runCommand(
          root,
          commandKind,
          existingWorkflowId,
          durableCommandId,
        );
        const retryBefore = await runCommand(
          root,
          commandKind,
          existingWorkflowId,
          durableCommandId,
        );
        assertState(acceptedCommand, expectedState);
        assertState(retryBefore, expectedState);
        const before = journalSnapshot(root);

        const prospective = await startWorkflow(
          root,
          sourceKind,
          prospectiveOpId,
        );
        const retryAfter = await runCommand(
          root,
          commandKind,
          existingWorkflowId,
          durableCommandId,
        );

        assert.equal(prospective.ok, false);
        assert.equal(
          prospective.ok ? null : prospective.error.code,
          'SpineIdempotencyConflict',
        );
        assert.equal(
          prospective.ok ? null : prospective.error.retryable,
          false,
        );
        assert.deepEqual(journalSnapshot(root), before);
        assertState(retryAfter, expectedState);
      } finally {
        if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
        else process.env.NVK_FAILPOINT = priorFailpoint;
        rmSync(workspace, { recursive: true, force: true });
      }
    });
  }
}

for (const sourceKind of ['message', 'artifact'] as const) {
  test(`${sourceKind} acceptance retry does not conflict with its own reservations`, async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), `nvk-spine-${sourceKind}-acceptance-retry-`),
    );
    const root = path.join(workspace, '.novakai');
    try {
      const clientOpId = `op_${sourceKind}_acceptance_retry`;
      const first = await startWorkflow(root, sourceKind, clientOpId);
      assertState(first, 'done');
      const before = journalSnapshot(root);

      const retry = await startWorkflow(root, sourceKind, clientOpId);

      assertState(retry, 'done');
      assert.equal(
        retry.ok && first.ok ? retry.value.workflowId : null,
        first.ok ? first.value.workflowId : null,
      );
      assert.deepEqual(journalSnapshot(root), before);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

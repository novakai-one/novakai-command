import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
} from '@novakai/foundation/dist/contract/index.js';
import { composeSpine } from '../contract/index.js';

interface TraceLine {
  clientOpId: string;
  target: {
    kind: string;
  };
}

function injectNextTraceFailure(root: string): void {
  composeHandle({
    root,
    dataRoot: path.join(root, 'stores'),
    capability: 'spine',
    allowedKinds: ['spineStep'],
    principal: 'sys_spine',
    failNextTraceAppend: {
      cause: 'injected accepted trace interruption',
    },
  });
}

function readSpineTraces(root: string): TraceLine[] {
  const tracePath = path.join(root, 'stores', 'traces.jsonl');
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceLine)
    .filter((line) => line.target.kind === 'spineStep');
}

test('retrying a workflow reconciles an accepted fact whose trace was interrupted', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-reconcile-'));
  const root = path.join(workspace, '.novakai');
  let messageQueries = 0;
  let projectAttaches = 0;
  try {
    injectNextTraceFailure(root);
    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          messageQueries += 1;
          return { kind: 'ok', value: { deliveries: [] } };
        },
      },
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('artifact dependency must not be called');
        },
      },
      projects: {
        async attach(projectId, input) {
          projectAttaches += 1;
          return {
            ok: true,
            value: {
              kind: 'projectItem',
              id: 'projectItem_reconciled',
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
    });
    const input = {
      messageId: 'message_reconciled' as never,
      projectId: 'proj_reconciled' as never,
    };
    const clientOpId = 'op_reconcile_accepted' as never;

    const interrupted = await spine.operations.addMessageToProject(
      input,
      clientOpId,
    );
    assert.equal(interrupted.ok, false);
    assert.equal(
      interrupted.ok ? null : interrupted.error.code,
      'TraceIncomplete',
    );
    assert.equal(readSpineTraces(root).length, 0);

    const retry = await spine.operations.addMessageToProject(
      input,
      clientOpId,
    );
    assert.equal(retry.ok, true);
    assert.equal(retry.ok ? retry.value.state : null, 'done');
    assert.equal(messageQueries, 1);
    assert.equal(projectAttaches, 1);

    const traces = readSpineTraces(root);
    assert.equal(traces.length, 5);
    assert.equal(
      traces.filter((trace) => trace.clientOpId === clientOpId).length,
      1,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

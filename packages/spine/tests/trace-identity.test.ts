import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { composeProjects } from '@novakai/projects';
import { composeSpine } from '../contract/index.js';

interface StoredLine {
  envelope: {
    id: string;
  };
  payload: {
    state: string;
    step: number;
    effectOpId?: string;
  };
  meta: {
    clientOpId: string;
  };
}

interface TraceLine {
  clientOpId: string;
  target: {
    kind: string;
    id: string;
  };
}

function readJsonl<T>(filePath: string): T[] {
  return readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

test('each journal mutation has one trace and keeps effect correlation IDs distinct', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-spine-traces-'));
  const root = path.join(workspace, '.novakai');
  try {
    const projects = composeProjects({ root, principal: 'sys_spine' });
    const project = await projects.operations.createProject(
      { title: 'Trace identities' },
      mintClientOpId(),
    );
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const spine = composeSpine({
      root,
      principal: 'sys_spine',
      messaging: {
        async getDelivery() {
          return { kind: 'ok', value: { deliveries: [] } };
        },
      },
      artifacts: {
        async getArtifactMeta() {
          return assert.fail('artifact dependency must not be called');
        },
      },
      projects: projects.spine,
    });
    const result = await spine.operations.addMessageToProject({
      messageId: 'message_traced' as never,
      projectId: project.value.id,
    }, 'op_trace_workflow' as never);
    assert.equal(result.ok, true);

    const journal = readJsonl<StoredLine>(
      path.join(root, 'stores', 'spineSteps.jsonl'),
    );
    const expectedMutationIds = [
      'op_trace_workflow',
      'op_trace_workflow:journal:step:1:running',
      'op_trace_workflow:journal:step:1:done',
      'op_trace_workflow:journal:step:2:running',
      'op_trace_workflow:journal:step:2:done',
    ];
    assert.deepEqual(
      journal.map((line) => line.meta.clientOpId),
      expectedMutationIds,
    );
    assert.deepEqual(
      journal
        .filter((line) => line.payload.step === 1)
        .map((line) => line.payload.effectOpId),
      [
        'op_trace_workflow:step:1',
        'op_trace_workflow:step:1',
      ],
    );
    assert.deepEqual(
      journal
        .filter((line) => line.payload.step === 2)
        .map((line) => line.payload.effectOpId),
      [
        'op_trace_workflow:step:2',
        'op_trace_workflow:step:2',
      ],
    );
    assert.equal(
      journal.some((line) =>
        line.meta.clientOpId === line.payload.effectOpId),
      false,
    );

    const traces = readJsonl<TraceLine>(
      path.join(root, 'stores', 'traces.jsonl'),
    );
    const journalTraceIds = traces
      .filter((trace) => trace.target.kind === 'spineStep')
      .map((trace) => trace.clientOpId);
    assert.deepEqual(journalTraceIds, expectedMutationIds);
    for (const line of journal) {
      assert.equal(
        traces.filter((trace) =>
          trace.target.kind === 'spineStep'
          && trace.target.id === line.envelope.id
          && trace.clientOpId === line.meta.clientOpId).length,
        1,
        line.meta.clientOpId,
      );
    }
    assert.equal(
      traces.filter((trace) =>
        trace.target.kind === 'projectItem'
        && trace.clientOpId === 'op_trace_workflow:step:2').length,
      1,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

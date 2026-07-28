import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
} from '@novakai/foundation/dist/contract/index.js';
import {
  MessagingError,
} from '@novakai/messaging/dist/public/index.js';
import { composeSpine } from '../contract/index.js';

interface TraceLine {
  clientOpId: string;
  target: {
    kind: string;
  };
}

interface JournalLine {
  envelope: {
    id: string;
  };
}

function injectNextTraceFailure(root: string): void {
  composeHandle({
    root,
    dataRoot: path.join(root, 'stores'),
    capability: 'spine',
    allowedKinds: ['spineStep'],
    principal: 'sys_spine',
    lockTimeoutMs: 20,
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

function assertEveryFactIsTraced(root: string): void {
  const journalPath = path.join(root, 'stores', 'spineSteps.jsonl');
  const journal = readFileSync(journalPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JournalLine);
  const traces = readSpineTraces(root);
  assert.equal(traces.length, journal.length);
  for (const line of journal) {
    assert.equal(
      traces.filter((trace) => trace.target.kind === 'spineStep'
        && (trace.target as { id?: string }).id === line.envelope.id).length,
      1,
      line.envelope.id,
    );
  }
}

function composeMessageWorkflow(
  root: string,
  getDelivery: () => Promise<
    | { kind: 'ok'; value: { deliveries: never[] } }
    | { kind: 'error'; error: MessagingError }
  > = async () => ({ kind: 'ok', value: { deliveries: [] } }),
) {
  return composeSpine({
    root,
    principal: 'sys_spine',
    lockTimeoutMs: 20,
    messaging: { getDelivery },
    artifacts: {
      async getArtifactMeta() {
        return assert.fail('artifact dependency must not be called');
      },
    },
    projects: {
      async attach(projectId, input) {
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
      lockTimeoutMs: 20,
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

test('mutating retries reconcile adjacent transition and command facts', async () => {
  const priorFailpoint = process.env.NVK_FAILPOINT;
  const workspaces: string[] = [];
  try {
    for (const state of ['running', 'done', 'failed'] as const) {
      const workspace = mkdtempSync(
        path.join(tmpdir(), `nvk-spine-reconcile-${state}-`),
      );
      workspaces.push(workspace);
      const root = path.join(workspace, '.novakai');
      const input = {
        messageId: `message_reconcile_${state}` as never,
        projectId: `proj_reconcile_${state}` as never,
      };
      const clientOpId = `op_reconcile_${state}` as never;

      if (state === 'running') {
        process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
        const accepting = composeMessageWorkflow(root);
        const accepted = await accepting.operations.addMessageToProject(
          input,
          clientOpId,
        );
        assert.equal(accepted.ok, false);
        delete process.env.NVK_FAILPOINT;
        injectNextTraceFailure(root);
        const interrupted = await composeMessageWorkflow(root)
          .operations.addMessageToProject(input, clientOpId);
        assert.equal(
          interrupted.ok ? null : interrupted.error.code,
          'TraceIncomplete',
        );
      } else {
        delete process.env.NVK_FAILPOINT;
        let inject = true;
        const interrupted = await composeMessageWorkflow(
          root,
          async () => {
            if (inject) {
              inject = false;
              injectNextTraceFailure(root);
            }
            if (state === 'failed') {
              return {
                kind: 'error',
                error: new MessagingError('UnknownMessage', {
                  fields: { messageId: input.messageId },
                }),
              };
            }
            return { kind: 'ok', value: { deliveries: [] } };
          },
        ).operations.addMessageToProject(input, clientOpId);
        assert.equal(
          interrupted.ok ? null : interrupted.error.code,
          'TraceIncomplete',
        );
      }

      const retry = await composeMessageWorkflow(
        root,
        state === 'failed'
          ? async () => ({
              kind: 'error',
              error: new MessagingError('UnknownMessage', {
                fields: { messageId: input.messageId },
              }),
            })
          : undefined,
      ).operations.addMessageToProject(input, clientOpId);
      assert.equal(retry.ok, true, state);
      assert.equal(
        retry.ok ? retry.value.state : null,
        state === 'failed' ? 'failed' : 'done',
        state,
      );
      assertEveryFactIsTraced(root);
    }

    for (const command of ['continue', 'abandon'] as const) {
      const workspace = mkdtempSync(
        path.join(tmpdir(), `nvk-spine-reconcile-${command}-`),
      );
      workspaces.push(workspace);
      const root = path.join(workspace, '.novakai');
      const input = {
        messageId: `message_reconcile_${command}` as never,
        projectId: `proj_reconcile_${command}` as never,
      };
      process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
      const accepting = composeMessageWorkflow(root);
      const accepted = await accepting.operations.addMessageToProject(
        input,
        `op_reconcile_source_${command}` as never,
      );
      assert.equal(accepted.ok, false);
      delete process.env.NVK_FAILPOINT;
      const scan = await composeMessageWorkflow(root).boot.scanWorkflows();
      assert.equal(scan.ok, true);
      if (!scan.ok) continue;
      const workflowId = scan.value.items[0]!.workflowId;
      const commandClientOpId = `op_reconcile_command_${command}` as never;

      injectNextTraceFailure(root);
      const interruptedHost = composeMessageWorkflow(root);
      const interrupted = command === 'continue'
        ? await interruptedHost.operations.continueWorkflow(
            workflowId,
            commandClientOpId,
          )
        : await interruptedHost.operations.abandonWorkflow(
            workflowId,
            commandClientOpId,
          );
      assert.equal(
        interrupted.ok ? null : interrupted.error.code,
        'TraceIncomplete',
      );

      const retryHost = composeMessageWorkflow(root);
      const retry = command === 'continue'
        ? await retryHost.operations.continueWorkflow(
            workflowId,
            commandClientOpId,
          )
        : await retryHost.operations.abandonWorkflow(
            workflowId,
            commandClientOpId,
          );
      assert.equal(retry.ok, true, command);
      assert.equal(
        retry.ok ? retry.value.state : null,
        command === 'continue' ? 'done' : 'abandoned',
        command,
      );
      assertEveryFactIsTraced(root);
    }
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    for (const workspace of workspaces) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test('a mutation never succeeds while terminal trace reconciliation is lock-blocked', async () => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'nvk-spine-reconcile-lock-'),
  );
  const root = path.join(workspace, '.novakai');
  try {
    let inject = true;
    const input = {
      messageId: 'message_reconcile_lock' as never,
      projectId: 'proj_reconcile_lock' as never,
    };
    const clientOpId = 'op_reconcile_lock' as never;
    const interrupted = await composeMessageWorkflow(
      root,
      async () => {
        if (inject) {
          inject = false;
          injectNextTraceFailure(root);
        }
        return {
          kind: 'error',
          error: new MessagingError('UnknownMessage', {
            fields: { messageId: input.messageId },
          }),
        };
      },
    ).operations.addMessageToProject(input, clientOpId);
    assert.equal(
      interrupted.ok ? null : interrupted.error.code,
      'TraceIncomplete',
    );
    assert.equal(readSpineTraces(root).length, 2);

    mkdirSync(path.join(root, 'lock'));
    writeFileSync(
      path.join(root, 'lock', 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'held-by-test' })}\n`,
    );
    const retry = await composeMessageWorkflow(root)
      .operations.addMessageToProject(input, clientOpId);

    assert.equal(retry.ok, false);
    assert.equal(
      retry.ok ? null : retry.error.code,
      'SpineJournalWriteFailed',
    );
    assert.equal(retry.ok ? null : retry.error.retryable, true);
    assert.equal(readSpineTraces(root).length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

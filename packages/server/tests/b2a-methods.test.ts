import test from 'node:test';
import assert from 'node:assert/strict';
import type { B2aServerCapabilities } from '../core/b2a/composition.js';
import { buildB2aMethods } from '../core/b2a/methods.js';

const EXACT_METHODS = [
  'abandonWorkflow',
  'addMessageToProject',
  'archiveProject',
  'attachArtifactToProject',
  'continueWorkflow',
  'createProject',
  'getArtifactMeta',
  'getProjectItems',
  'getSpineWorkflows',
  'listArtifacts',
  'listProjects',
];

function harness(): {
  capabilities: B2aServerCapabilities;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const operation = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    return { ok: true, value: { method } };
  };
  return {
    calls,
    capabilities: {
      projects: {
        operations: {
          createProject: operation('createProject'),
          archiveProject: operation('archiveProject'),
          listProjects: operation('listProjects'),
          getProjectItems: operation('getProjectItems'),
        },
        spine: {
          createProject: operation('spine.createProject'),
          archiveProject: operation('spine.archiveProject'),
          listProjects: operation('spine.listProjects'),
          getProjectItems: operation('spine.getProjectItems'),
          attach: operation('projects.attach'),
        },
      },
      artifacts: {
        operations: {
          putArtifact: operation('putArtifact'),
          getArtifactMeta: operation('getArtifactMeta'),
          listArtifacts: operation('listArtifacts'),
        },
        http: {
          getArtifactBytes: operation('getArtifactBytes'),
        },
        boot: {
          sweepOrphans: operation('sweepOrphans'),
        },
      },
      spine: {
        operations: {
          addMessageToProject: operation('addMessageToProject'),
          attachArtifactToProject: operation('attachArtifactToProject'),
          continueWorkflow: operation('continueWorkflow'),
          abandonWorkflow: operation('abandonWorkflow'),
          getSpineWorkflows: operation('getSpineWorkflows'),
        },
        boot: {
          scanWorkflows: operation('scanWorkflows'),
        },
      },
    } as unknown as B2aServerCapabilities,
  };
}

test('B2a WS methods expose exactly eleven non-byte operations through public contracts', async () => {
  const h = harness();
  const methods = buildB2aMethods(h.capabilities);
  assert.deepEqual(Object.keys(methods).sort(), EXACT_METHODS);
  assert.equal('attach' in methods, false);
  assert.equal('putArtifact' in methods, false);
  assert.equal('getArtifactBytes' in methods, false);

  const valid: Array<[string, unknown, string]> = [
    ['createProject', {
      title: 'WS Project',
      permissionLevel: 'team',
      clientOpId: 'op_ws_create',
    }, 'createProject'],
    ['archiveProject', {
      projectId: 'proj_ws',
      clientOpId: 'op_ws_archive',
    }, 'archiveProject'],
    ['listProjects', { status: 'active' }, 'listProjects'],
    ['getProjectItems', { projectId: 'proj_ws' }, 'getProjectItems'],
    ['addMessageToProject', {
      messageId: 'message_ws',
      projectId: 'proj_ws',
      note: 'message evidence',
      clientOpId: 'op_ws_message',
    }, 'addMessageToProject'],
    ['attachArtifactToProject', {
      artifactId: 'artifact_ws',
      projectId: 'proj_ws',
      note: 'artifact evidence',
      clientOpId: 'op_ws_artifact',
    }, 'attachArtifactToProject'],
    ['getArtifactMeta', { artifactId: 'artifact_ws' }, 'getArtifactMeta'],
    ['listArtifacts', undefined, 'listArtifacts'],
    ['getSpineWorkflows', {}, 'getSpineWorkflows'],
    ['continueWorkflow', {
      workflowId: 'spineWorkflow_ws',
      clientOpId: 'op_ws_continue',
    }, 'continueWorkflow'],
    ['abandonWorkflow', {
      workflowId: 'spineWorkflow_ws',
      clientOpId: 'op_ws_abandon',
    }, 'abandonWorkflow'],
  ];

  for (const [method, params, delegated] of valid) {
    const result = await methods[method]!(params as never) as {
      ok: boolean;
      value?: { method: string };
    };
    assert.equal(result.ok, true, method);
    assert.equal(result.value?.method, delegated, method);
  }
  assert.deepEqual(h.calls.map(({ method }) => method), valid.map((entry) => entry[2]));
});

test('every B2a WS method rejects malformed external input before delegation', async () => {
  const h = harness();
  const methods = buildB2aMethods(h.capabilities);
  const invalid: Array<[string, unknown]> = [
    ['createProject', { title: '', clientOpId: '' }],
    ['archiveProject', { projectId: 'wrong', clientOpId: 'op_archive' }],
    ['listProjects', { status: 'deleted' }],
    ['getProjectItems', { projectId: 'wrong' }],
    ['addMessageToProject', {
      messageId: 'wrong',
      projectId: 'proj_ws',
      clientOpId: 'op_message',
    }],
    ['attachArtifactToProject', {
      artifactId: 'wrong',
      projectId: 'proj_ws',
      clientOpId: 'op_artifact',
    }],
    ['getArtifactMeta', { artifactId: 'wrong' }],
    ['listArtifacts', { bytes: 'forbidden' }],
    ['getSpineWorkflows', { autoContinue: true }],
    ['continueWorkflow', { workflowId: 'wrong', clientOpId: 'op_continue' }],
    ['abandonWorkflow', {
      workflowId: 'spineWorkflow_ws',
      clientOpId: '',
    }],
  ];

  for (const [method, params] of invalid) {
    const result = await methods[method]!(params as never) as {
      ok: boolean;
      error?: {
        code?: string;
        message?: string;
        details?: unknown;
        retryable?: boolean;
      };
    };
    assert.equal(result.ok, false, method);
    assert.equal(result.error?.code, 'InvalidEnvelope', method);
    assert.equal(result.error?.message, `${method} input is invalid`, method);
    assert.ok(result.error?.details, method);
    assert.equal(result.error?.retryable, false, method);
  }
  assert.deepEqual(h.calls, []);
});

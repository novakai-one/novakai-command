import test from 'node:test';
import assert from 'node:assert/strict';
import type { B2aServerCapabilities } from '../../core/b2a/composition.js';
import { buildB2aMethods } from '../../core/b2a/methods.js';

const EXACT_METHODS = [
  'archiveProject',
  'createProject',
  'getArtifactMeta',
  'getProjectItems',
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
    if (method === 'getArtifactMeta') {
      return {
        ok: true,
        value: {
          id: 'artifact_ws',
          kind: 'artifact',
          schemaVersion: 1,
          createdAt: '2026-07-29T00:00:00.000Z',
          permissionLevel: 'private',
          createdBy: 'person_operator',
          mimeType: 'text/plain',
          byteSize: 42,
        },
      };
    }
    if (method === 'listArtifacts') {
      return { ok: true, value: { items: [] } };
    }
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
    } as unknown as B2aServerCapabilities,
  };
}

test('B2a WS methods expose exactly six non-byte operations through public contracts', async () => {
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
    ['getArtifactMeta', { artifactId: 'artifact_ws' }, 'getArtifactMeta'],
    ['listArtifacts', undefined, 'listArtifacts'],
  ];

  for (const [method, params, delegated] of valid) {
    const result = await methods[method]!(params as never) as {
      ok: boolean;
      value?: { method: string };
    };
    assert.equal(result.ok, true, method);
    if (delegated !== 'getArtifactMeta' && delegated !== 'listArtifacts') {
      assert.equal(result.value?.method, delegated, method);
    }
  }
  assert.deepEqual(h.calls.map(({ method }) => method), valid.map((entry) => entry[2]));
});

test('WS Artifact metadata omits operator provenance from get and list responses', async () => {
  const h = harness();
  const rawArtifact = {
    id: 'artifact_private',
    kind: 'artifact',
    schemaVersion: 1,
    createdAt: '2026-07-29T00:00:00.000Z',
    permissionLevel: 'private',
    createdBy: 'person_operator',
    mimeType: 'text/plain',
    byteSize: 42,
    status: 'stored',
    originPath: '/private/operator/path/secret.txt',
    sourceAttribution: {
      origin: 'operator-machine',
      originalId: 'secret-source',
      ingestedAt: '2026-07-29T00:00:00.000Z',
    },
  };
  h.capabilities.artifacts.operations.getArtifactMeta = async () => ({
    ok: true,
    value: rawArtifact,
  }) as never;
  h.capabilities.artifacts.operations.listArtifacts = async () => ({
    ok: true,
    value: { items: [rawArtifact], nextCursor: 'artifact_cursor' },
  }) as never;
  const methods = buildB2aMethods(h.capabilities);
  const expected = {
    id: rawArtifact.id,
    kind: rawArtifact.kind,
    mimeType: rawArtifact.mimeType,
    byteSize: rawArtifact.byteSize,
    createdAt: rawArtifact.createdAt,
    status: rawArtifact.status,
  };

  const metadata = await methods.getArtifactMeta!({
    artifactId: rawArtifact.id,
  } as never);
  const listed = await methods.listArtifacts!({} as never);

  assert.deepEqual(metadata, { ok: true, value: expected });
  assert.deepEqual(listed, {
    ok: true,
    value: { items: [expected], nextCursor: 'artifact_cursor' },
  });
  assert.equal(JSON.stringify(metadata).includes('originPath'), false);
  assert.equal(JSON.stringify(metadata).includes('sourceAttribution'), false);
  assert.equal(JSON.stringify(listed).includes('originPath'), false);
  assert.equal(JSON.stringify(listed).includes('sourceAttribution'), false);
});

test('every B2a WS method rejects malformed external input before delegation', async () => {
  const h = harness();
  const methods = buildB2aMethods(h.capabilities);
  const invalid: Array<[string, unknown]> = [
    ['createProject', { title: '', clientOpId: '' }],
    ['archiveProject', { projectId: 'wrong', clientOpId: 'op_archive' }],
    ['listProjects', { status: 'deleted' }],
    ['getProjectItems', { projectId: 'wrong' }],
    ['getArtifactMeta', { artifactId: 'wrong' }],
    ['listArtifacts', { bytes: 'forbidden' }],
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

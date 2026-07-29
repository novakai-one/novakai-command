import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  composeEngine,
} from '@novakai/foundation/dist/contract/compose.js';
import {
  mintClientOpId,
  queryTraceBound,
} from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';
import {
  bootServer,
  type NovakaiServer,
} from '../core/boot.js';

const connect = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) =>
      reject(new Error(`http ${response.statusCode}`)));
  });

const rpc = (
  ws: WebSocket,
  id: number,
  method: string,
  params?: unknown,
): Promise<{
  id: number;
  result?: unknown;
  error?: string;
}> => new Promise((resolve) => {
  ws.on('message', function handler(raw) {
    const frame = JSON.parse(String(raw)) as {
      id?: number;
      type?: string;
      result?: unknown;
      error?: string;
    };
    if (frame.type === 'event' || frame.id !== id) return;
    ws.off('message', handler);
    resolve(frame as { id: number; result?: unknown; error?: string });
  });
  ws.send(JSON.stringify({ id, method, params, v: 1 }));
});

async function provisionHuman(root: string): Promise<void> {
  const opened = await openConfigStore({ root, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const token = opened.value.mintPrincipalToken({
    personId: 'person_chris',
    roles: ['Human'],
    grants: [
      'layout',
      'settings',
      'conversationView',
      'project',
      'projectItem',
      'artifact',
      'spineStep',
    ],
  });
  const configured = await opened.value.set(
    {
      configKind: 'principal',
      personId: 'person_chris',
      roles: ['Human'],
      tokenId: token.id,
    },
    mintClientOpId(),
  );
  assert.equal(configured.ok, true);
}

async function boot(root: string): Promise<NovakaiServer> {
  const result = await bootServer({
    root,
    port: 0,
    cwd: root,
    watchdogDir: root,
    supervisionTimers: false,
  });
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

function unwrap<T>(frame: { result?: unknown; error?: string }): T {
  assert.equal(frame.error, undefined, frame.error);
  const result = frame.result as {
    ok: boolean;
    value?: T;
    error?: unknown;
  };
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.value as T;
}

function assertTypedFailure(
  frame: { result?: unknown; error?: string },
  expectedCode: string,
): void {
  assert.equal(frame.error, undefined, frame.error);
  const result = frame.result as {
    ok: boolean;
    error?: { code?: string; message?: string };
  };
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, expectedCode);
  assert.match(result.error?.message ?? '', /injected Spine failure/i);
}

test('Server restart discovers accepted WS workflows for explicit continue or abandon', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b2a-recovery-'));
  const priorFailpoint = process.env.NVK_FAILPOINT;
  let first: NovakaiServer | null = null;
  let second: NovakaiServer | null = null;
  try {
    await provisionHuman(root);
    process.env.NVK_FAILPOINT = 'spine.journal.accepted.after';
    first = await boot(root);
    const firstSocket = await connect(
      `${first.url.replace('http', 'ws')}/ws?token=${first.token}`,
    );

    const project = unwrap<{ id: string }>(await rpc(
      firstSocket,
      1,
      'createProject',
      {
        title: 'Recovery Project',
        clientOpId: 'op_server_project',
      },
    ));
    const policy = await first.runtime.human.holder.call((session) =>
      (session as {
        setContactPolicy(input: unknown): Promise<unknown>;
      }).setContactPolicy({
        allowlist: ['person_chris'],
        defaultRule: 'deny',
      })) as { kind: string; error?: { message?: string } };
    assert.equal(policy.kind, 'ok', policy.error?.message);
    const sent = await first.runtime.human.holder.call((session) =>
      (session as {
        sendMessage(input: unknown): Promise<unknown>;
      }).sendMessage({
        address: 'person:person_chris',
        body: { text: 'recovery source' },
        priority: 'normal',
        clientMessageId: 'b2a-recovery-source',
      })) as {
        kind: string;
        value?: { messageId: string };
        error?: { message?: string };
      };
    assert.equal(sent.kind, 'ok', sent.error?.message);
    assert.ok(sent.value);

    const artifactSecret = 'B2A_SERVER_RAW_SECRET';
    const artifactBytes = Uint8Array.from([
      ...Buffer.from(artifactSecret, 'utf8'),
      0,
      255,
      129,
      13,
      10,
    ]);
    const posted = await fetch(`${first.url}/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${first.token}`,
        'content-type': 'application/octet-stream',
        'x-novakai-client-op-id': 'op_server_artifact',
      },
      body: artifactBytes,
    });
    assert.equal(posted.status, 201);
    const artifact = await posted.json() as { id: string };

    const interruptedMessage = await rpc(
      firstSocket,
      2,
      'addMessageToProject',
      {
        messageId: sent.value!.messageId,
        projectId: project.id,
        clientOpId: 'op_server_pending_message',
      },
    );
    assertTypedFailure(interruptedMessage, 'SpineFailpoint');
    const interruptedArtifact = await rpc(
      firstSocket,
      3,
      'attachArtifactToProject',
      {
        artifactId: artifact.id,
        projectId: project.id,
        clientOpId: 'op_server_pending_artifact',
      },
    );
    assertTypedFailure(interruptedArtifact, 'SpineFailpoint');
    const pendingBeforeRestart = unwrap<{ items: Array<{
      workflowId: string;
      workflowType: string;
      state: string;
    }> }>(await rpc(firstSocket, 4, 'getSpineWorkflows', {}));
    assert.equal(pendingBeforeRestart.items.length, 2);
    assert.equal(
      pendingBeforeRestart.items.every(({ state }) => state === 'accepted'),
      true,
    );

    firstSocket.close();
    await first.close();
    first = null;
    delete process.env.NVK_FAILPOINT;

    mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    const orphanPath = path.join(root, 'artifacts', 'artifact_orphan-boot');
    writeFileSync(orphanPath, 'orphan');
    second = await boot(root);
    const artifactStep = second.steps.find(({ name }) => name === 'artifacts');
    const spineStep = second.steps.find(({ name }) => name === 'spine');
    assert.match(artifactStep?.detail ?? '', /^1 orphan byte file/);
    assert.match(spineStep?.detail ?? '', /^2 resumable workflow/);
    assert.equal(
      readdirSync(path.join(root, 'artifacts')).includes('artifact_orphan-boot'),
      false,
      'Artifact boot maintenance swept the orphan',
    );

    const secondSocket = await connect(
      `${second.url.replace('http', 'ws')}/ws?token=${second.token}`,
    );
    const discovered = unwrap<{ items: Array<{
      workflowId: string;
      workflowType: string;
      state: string;
    }> }>(await rpc(secondSocket, 5, 'getSpineWorkflows', {}));
    assert.equal(
      discovered.items.every(({ state }) => state === 'accepted'),
      true,
      'boot discovers pending workflows without continuing them',
    );
    const messageWorkflow = discovered.items.find(({ workflowType }) =>
      workflowType === 'addMessageToProject')!;
    const artifactWorkflow = discovered.items.find(({ workflowType }) =>
      workflowType === 'attachArtifactToProject')!;
    const continued = unwrap<{ state: string }>(await rpc(
      secondSocket,
      6,
      'continueWorkflow',
      {
        workflowId: messageWorkflow.workflowId,
        clientOpId: 'op_server_continue',
      },
    ));
    const abandoned = unwrap<{ state: string }>(await rpc(
      secondSocket,
      7,
      'abandonWorkflow',
      {
        workflowId: artifactWorkflow.workflowId,
        clientOpId: 'op_server_abandon',
      },
    ));
    assert.equal(continued.state, 'done');
    assert.equal(abandoned.state, 'abandoned');

    const items = unwrap<{ items: Array<{
      itemRef: { kind: string; id: string };
    }> }>(await rpc(secondSocket, 8, 'getProjectItems', {
      projectId: project.id,
    }));
    assert.deepEqual(items.items.map(({ itemRef }) => itemRef), [{
      kind: 'message',
      id: sent.value!.messageId,
    }]);
    const downloaded = await fetch(`${second.url}/artifacts/${artifact.id}`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.deepEqual(
      new Uint8Array(await downloaded.arrayBuffer()),
      artifactBytes,
    );
    secondSocket.close();

    const traces = await queryTraceBound(composeEngine({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'server',
      allowedKinds: ['trace'],
      principal: 'person_chris',
    }), {});
    for (const clientOpId of [
      'op_server_project',
      'op_server_artifact',
      'op_server_pending_message',
      'op_server_pending_artifact',
      'op_server_continue',
      'op_server_abandon',
    ]) {
      assert.equal(
        traces.items.filter((trace) => trace.clientOpId === clientOpId).length,
        1,
        `${clientOpId} has exactly one caller-correlated trace`,
      );
    }
    const jsonl = readdirSync(path.join(root, 'stores'))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readFileSync(path.join(root, 'stores', name), 'utf8'))
      .join('\n');
    assert.equal(jsonl.includes('"bytes"'), false);
    assert.equal(jsonl.includes(artifactSecret), false);
    assert.equal(
      jsonl.includes(Buffer.from(artifactBytes).toString('base64')),
      false,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    await first?.close();
    await second?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

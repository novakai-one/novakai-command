// B1a slice 6 — nvk-ws v1 transport (DEC-B1-9, red gate 4).
// One port serves the shell bundle, /bootstrap.json and the WS upgrade.
// A connection without the token is rejected BEFORE any method can dispatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { request as requestHttp } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../contract/protocol.js';
import { startTransport, type RunningTransport } from '../core/transport/server.js';
import {
  ABSENT,
  type ArtifactId,
} from '@novakai/foundation/dist/contract/index.js';

const root = () => mkdtempSync(path.join(tmpdir(), 'nvk-transport-'));

interface Harness { transport: RunningTransport; dispatched: string[]; dir: string }

async function boot(options: { staticDir?: string } = {}): Promise<Harness> {
  const dir = root();
  const dispatched: string[] = [];
  const transport = await startTransport({
    root: dir,
    port: 0, // ephemeral: tests never fight over a fixed port
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    methods: {
      async echo(params: unknown) { dispatched.push('echo'); return { echoed: params }; },
      async explode() { dispatched.push('explode'); throw new Error('kaboom'); },
    },
  });
  return { transport, dispatched, dir };
}

async function bootWithArtifacts(maxUploadBytes?: number): Promise<{
  transport: RunningTransport;
  calls: string[];
  stored: {
    bytes: Uint8Array<ArrayBuffer>;
    mimeType: string;
    clientOpId: string;
  } | null;
}> {
  const dir = root();
  const calls: string[] = [];
  let stored: {
    bytes: Uint8Array<ArrayBuffer>;
    mimeType: string;
    clientOpId: string;
  } | null = null;
  const metadata = {
    kind: 'artifact' as const,
    id: 'artifact_http' as ArtifactId,
    schemaVersion: 1 as const,
    createdAt: '2026-07-29T00:00:00.000Z',
    permissionLevel: 'private' as const,
    createdBy: 'person_chris',
    mimeType: 'application/octet-stream',
    byteSize: 0,
  };
  const transportOptions: Parameters<typeof startTransport>[0] = {
    root: dir,
    port: 0,
    methods: {},
    artifactMaxUploadBytes: maxUploadBytes,
    artifacts: {
      operations: {
        async putArtifact(input, clientOpId) {
          calls.push('putArtifact');
          stored = {
            bytes: input.bytes,
            mimeType: input.mimeType,
            clientOpId,
          };
          return {
            ok: true,
            value: {
              ...metadata,
              mimeType: input.mimeType,
              byteSize: input.bytes.byteLength,
            },
          };
        },
        async getArtifactMeta() {
          calls.push('getArtifactMeta');
          return {
            ok: true,
            value: stored
              ? {
                  ...metadata,
                  mimeType: stored.mimeType,
                  byteSize: stored.bytes.byteLength,
                }
              : ABSENT({ kind: 'artifact', id: 'artifact_http' }),
          };
        },
        async listArtifacts() {
          throw new Error('not used by HTTP');
        },
      },
      http: {
        async getArtifactBytes() {
          calls.push('getArtifactBytes');
          return {
            ok: true,
            value: stored?.bytes
              ?? ABSENT({ kind: 'artifact', id: 'artifact_http' }),
          };
        },
      },
    },
  };
  const transport = await startTransport(transportOptions);
  return {
    transport,
    calls,
    get stored() {
      return stored;
    },
  };
}

function postArtifactChunks(
  url: string,
  token: string,
  chunks: readonly Uint8Array[],
  contentLength?: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-novakai-client-op-id': 'op_http_oversized',
        ...(contentLength === undefined
          ? {}
          : { 'content-length': String(contentLength) }),
      },
    }, (response) => {
      const responseChunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => responseChunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(responseChunks).toString('utf8');
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body) as unknown;
        } catch {
          // Authentication failures intentionally use the transport's text body.
        }
        resolve({
          status: response.statusCode ?? 0,
          body: parsed,
        });
      });
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

const connect = (url: string): Promise<WebSocket> => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.once('open', () => resolve(ws));
  ws.once('error', reject);
  ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
});

const rpc = (ws: WebSocket, frame: object): Promise<Record<string, unknown>> => new Promise((resolve) => {
  ws.on('message', function handler(raw) {
    const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
    if (parsed.type === 'event') return; // events interleave; this waits for the reply
    ws.off('message', handler);
    resolve(parsed);
  });
  ws.send(JSON.stringify(frame));
});

test('GET /bootstrap.json hands the page its wsUrl, token and protocol version', async () => {
  const h = await boot();
  const res = await fetch(`${h.transport.url}/bootstrap.json`);
  assert.equal(res.status, 200);
  const body = await res.json() as { wsUrl: string; token: string; protocolVersion: number };

  assert.equal(body.protocolVersion, PROTOCOL_VERSION);
  assert.ok(body.wsUrl.startsWith('ws://127.0.0.1:'), 'the socket is loopback-only (red gate 4)');
  assert.equal(body.token, h.transport.token);

  const tokenFile = path.join(h.dir, 'server', 'ws-token');
  assert.equal(readFileSync(tokenFile, 'utf8').trim(), body.token);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'the token file is mode 600');
  await h.transport.close();
});

test('a WS connection without a token is rejected before any method can dispatch', async () => {
  const h = await boot();
  await assert.rejects(() => connect(h.transport.url.replace('http', 'ws') + '/ws'), /401/);
  await assert.rejects(() => connect(`${h.transport.url.replace('http', 'ws')}/ws?token=not-the-token`), /401/);
  assert.deepEqual(h.dispatched, [], 'nothing was dispatched for an unauthenticated socket');
  await h.transport.close();
});

test('an authenticated request/response round-trips in the nvk-ws v1 frame shape', async () => {
  const h = await boot();
  const ws = await connect(`${h.transport.url.replace('http', 'ws')}/ws?token=${h.transport.token}`);

  const reply = await rpc(ws, { id: 7, method: 'echo', params: { hello: 'world' }, v: 1 });
  assert.deepEqual(reply, { id: 7, result: { echoed: { hello: 'world' } }, v: 1 });
  assert.deepEqual(h.dispatched, ['echo']);

  ws.close();
  await h.transport.close();
});

test('unsupported present protocol versions reject without dispatch while v1 and legacy absent versions dispatch', async (t) => {
  const h = await boot();
  t.after(() => h.transport.close());
  const ws = await connect(
    `${h.transport.url.replace('http', 'ws')}/ws?token=${h.transport.token}`,
  );

  const unsupported = await rpc(ws, {
    id: 8,
    method: 'echo',
    params: 'must-not-dispatch',
    v: 999,
  });
  assert.deepEqual(unsupported, {
    id: 8,
    error: {
      code: 'UnsupportedProtocolVersion',
      message: 'protocol version 999 is not supported; expected 1',
      details: { received: 999, supported: [1] },
      retryable: false,
    },
    v: 1,
  });
  assert.deepEqual(h.dispatched, []);

  const explicitV1 = await rpc(ws, {
    id: 9,
    method: 'echo',
    params: 'explicit-v1',
    v: 1,
  });
  const legacyV1 = await rpc(ws, {
    id: 10,
    method: 'echo',
    params: 'legacy-v1',
  });
  assert.deepEqual(explicitV1, {
    id: 9,
    result: { echoed: 'explicit-v1' },
    v: 1,
  });
  assert.deepEqual(legacyV1, {
    id: 10,
    result: { echoed: 'legacy-v1' },
    v: 1,
  });
  assert.deepEqual(h.dispatched, ['echo', 'echo']);

  ws.close();
});

test('an unknown method and a throwing method both answer typed, and the socket survives', async () => {
  const h = await boot();
  const ws = await connect(`${h.transport.url.replace('http', 'ws')}/ws?token=${h.transport.token}`);

  const unknown = await rpc(ws, { id: 1, method: 'nope', v: 1 });
  assert.equal(unknown.id, 1);
  assert.match(String(unknown.error), /unknown method/);
  assert.equal(unknown.v, 1);

  const threw = await rpc(ws, { id: 2, method: 'explode', v: 1 });
  assert.equal(threw.id, 2);
  assert.match(String(threw.error), /kaboom/);

  const stillAlive = await rpc(ws, { id: 3, method: 'echo', params: 'ok', v: 1 });
  assert.deepEqual(stillAlive.result, { echoed: 'ok' });

  ws.close();
  await h.transport.close();
});

test('broadcast events carry the protocol version and reach every authenticated socket', async () => {
  const h = await boot();
  const wsUrl = `${h.transport.url.replace('http', 'ws')}/ws?token=${h.transport.token}`;
  const [a, b] = await Promise.all([connect(wsUrl), connect(wsUrl)]);

  const received = Promise.all([a, b].map((ws) => new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
  })));
  h.transport.broadcast('presence', { agentId: 'agent_1' });
  const frames = await received;

  for (const frame of frames) {
    assert.deepEqual(frame, { type: 'event', name: 'presence', data: { agentId: 'agent_1' }, v: 1 });
  }
  a.close(); b.close();
  await h.transport.close();
});

test('the shell bundle is served from the same port, with an index fallback for routes', async () => {
  const staticDir = mkdtempSync(path.join(tmpdir(), 'nvk-static-'));
  mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>novakai</title>');
  writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'export const x = 1;\n');
  const h = await boot({ staticDir });

  const index = await fetch(`${h.transport.url}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /novakai/);

  const asset = await fetch(`${h.transport.url}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);

  const deepRoute = await fetch(`${h.transport.url}/agents/anything`);
  assert.equal(deepRoute.status, 200, 'unknown routes fall back to the shell index');
  assert.match(await deepRoute.text(), /novakai/);

  const traversal = await fetch(`${h.transport.url}/../../etc/passwd`);
  assert.notEqual(traversal.status, 500);
  assert.equal((await traversal.text()).includes('root:'), false, 'no path escapes the bundle');
  await h.transport.close();
});

test('the server binds loopback only (red gate 4)', async () => {
  const h = await boot();
  assert.equal(h.transport.address, '127.0.0.1');
  await h.transport.close();
});

test('Artifact HTTP authenticates before access and preserves exact bytes with safe metadata headers', async (t) => {
  const h = await bootWithArtifacts();
  t.after(() => h.transport.close());
  const bytes = Uint8Array.from([0, 255, 128, 64, 13, 10, 1]);

  const missingAuth = await fetch(`${h.transport.url}/artifacts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-novakai-test',
      'x-novakai-client-op-id': 'op_http_put',
    },
    body: bytes,
  });
  assert.equal(missingAuth.status, 401);
  const wrongAuth = await fetch(`${h.transport.url}/artifacts/artifact_http`, {
    headers: { authorization: 'Bearer wrong' },
  });
  assert.equal(wrongAuth.status, 401);
  assert.deepEqual(h.calls, [], 'auth is checked before any Artifact access');

  const missingOpId = await fetch(`${h.transport.url}/artifacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.transport.token}` },
    body: bytes,
  });
  assert.equal(missingOpId.status, 400);
  assert.deepEqual(h.calls, [], 'invalid metadata is rejected before byte storage');

  const posted = await fetch(`${h.transport.url}/artifacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${h.transport.token}`,
      'content-type': 'application/x-novakai-test',
      'x-novakai-client-op-id': 'op_http_put',
    },
    body: bytes,
  });
  assert.equal(posted.status, 201);
  const created = await posted.json() as {
    id: string;
    byteSize: number;
    bytes?: unknown;
  };
  assert.equal(created.id, 'artifact_http');
  assert.equal(created.byteSize, bytes.byteLength);
  assert.equal(created.bytes, undefined, 'POST JSON never echoes bytes');
  assert.deepEqual(h.stored, {
    bytes,
    mimeType: 'application/x-novakai-test',
    clientOpId: 'op_http_put',
  });

  h.calls.length = 0;
  const downloaded = await fetch(
    `${h.transport.url}/artifacts/artifact_http`,
    { headers: { authorization: `Bearer ${h.transport.token}` } },
  );
  assert.equal(downloaded.status, 200);
  assert.equal(
    downloaded.headers.get('content-type'),
    'application/x-novakai-test',
  );
  assert.equal(
    downloaded.headers.get('content-length'),
    String(bytes.byteLength),
  );
  assert.equal(
    downloaded.headers.get('x-novakai-artifact-id'),
    'artifact_http',
  );
  assert.deepEqual(
    new Uint8Array(await downloaded.arrayBuffer()),
    bytes,
  );
  assert.deepEqual(h.calls, ['getArtifactMeta', 'getArtifactBytes']);
});

test('Artifact HTTP rejects declared oversized uploads before capability access', async (t) => {
  const h = await bootWithArtifacts(4);
  t.after(() => h.transport.close());
  const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

  const unauthenticated = await postArtifactChunks(
    `${h.transport.url}/artifacts`,
    'wrong',
    [bytes],
    bytes.byteLength,
  );
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(h.calls, [], 'authentication remains the first boundary');

  const oversized = await postArtifactChunks(
    `${h.transport.url}/artifacts`,
    h.transport.token,
    [bytes],
    bytes.byteLength,
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body, {
    code: 'ArtifactUploadTooLarge',
    message: 'artifact upload exceeds the 4 byte limit',
    details: { maxUploadBytes: 4 },
    retryable: false,
  });
  assert.deepEqual(h.calls, [], 'declared overflow never reaches Artifact capabilities');

  const artifactHttp = await import('../core/b2a/artifact-http.js') as {
    MAX_ARTIFACT_UPLOAD_BYTES?: number;
  };
  assert.equal(
    artifactHttp.MAX_ARTIFACT_UPLOAD_BYTES,
    64 * 1024 * 1024,
    'the production default is declared at the internal HTTP adapter',
  );
});

test('Artifact HTTP bounds chunked uploads and rejects streaming overflow', async (t) => {
  const h = await bootWithArtifacts(4);
  t.after(() => h.transport.close());

  const oversized = await postArtifactChunks(
    `${h.transport.url}/artifacts`,
    h.transport.token,
    [
      Uint8Array.from([1, 2, 3]),
      Uint8Array.from([4, 5, 6]),
    ],
  );

  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body, {
    code: 'ArtifactUploadTooLarge',
    message: 'artifact upload exceeds the 4 byte limit',
    details: { maxUploadBytes: 4 },
    retryable: false,
  });
  assert.deepEqual(h.calls, [], 'streaming overflow never reaches Artifact capabilities');
});

import type {
  IncomingMessage,
  ServerResponse,
} from 'node:http';
import {
  isAbsent,
  type ArtifactId,
  type ClientOpId,
} from '@novakai/foundation/dist/contract/index.js';
import type { ArtifactsHost } from '../../../artifacts/contract/index.js';

export interface ArtifactHttpRequestOptions {
  request: IncomingMessage;
  response: ServerResponse;
  token: string;
  artifacts: Pick<ArtifactsHost, 'operations' | 'http'>;
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function errorStatus(error: { code?: string }): number {
  if (error.code === 'InvalidEnvelope') return 400;
  if (error.code === 'NotFound') return 404;
  if (error.code === 'LockBusy') return 409;
  return 503;
}

function safeMimeType(value: string): string {
  const mediaType =
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
  return mediaType.test(value) ? value : 'application/octet-stream';
}

async function readBytes(
  request: IncomingMessage,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const combined = Buffer.concat(chunks);
  const bytes = new Uint8Array(combined.byteLength);
  bytes.set(combined);
  return bytes;
}

function authorized(request: IncomingMessage, token: string): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

/**
 * Handle the two byte-bearing Artifact routes. Returns false for every other
 * HTTP request so the ordinary Server transport can continue routing it.
 */
export async function handleArtifactHttpRequest(
  options: ArtifactHttpRequestOptions,
): Promise<boolean> {
  const { request, response, token, artifacts } = options;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const isPut = request.method === 'POST' && url.pathname === '/artifacts';
  const artifactMatch = request.method === 'GET'
    ? /^\/artifacts\/(artifact_[A-Za-z0-9_-]+)$/.exec(url.pathname)
    : null;
  if (!isPut && !artifactMatch) return false;

  // This check precedes body reads and every Artifact contract call.
  if (!authorized(request, token)) {
    response.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('unauthorized');
    return true;
  }

  if (isPut) {
    const clientOpId = request.headers['x-novakai-client-op-id'];
    if (typeof clientOpId !== 'string' || clientOpId.length === 0) {
      writeJson(response, 400, {
        code: 'InvalidEnvelope',
        message: 'x-novakai-client-op-id is required',
      });
      return true;
    }
    const mimeTypeHeader = request.headers['content-type'];
    const mimeType = typeof mimeTypeHeader === 'string'
      ? safeMimeType(mimeTypeHeader)
      : 'application/octet-stream';
    const bytes = await readBytes(request);
    const result = await artifacts.operations.putArtifact(
      { bytes, mimeType },
      clientOpId as ClientOpId,
    );
    if (!result.ok) {
      writeJson(response, errorStatus(result.error), result.error);
      return true;
    }
    writeJson(response, 201, result.value);
    return true;
  }

  const artifactId = artifactMatch![1] as ArtifactId;
  const metadata = await artifacts.operations.getArtifactMeta(artifactId);
  if (!metadata.ok) {
    writeJson(response, errorStatus(metadata.error), metadata.error);
    return true;
  }
  if (isAbsent(metadata.value)) {
    writeJson(response, 404, {
      code: 'NotFound',
      message: `no artifact with id "${artifactId}"`,
    });
    return true;
  }
  const content = await artifacts.http.getArtifactBytes(artifactId);
  if (!content.ok) {
    writeJson(response, errorStatus(content.error), content.error);
    return true;
  }
  if (isAbsent(content.value)) {
    writeJson(response, 404, {
      code: 'NotFound',
      message: `artifact bytes are absent for "${artifactId}"`,
    });
    return true;
  }
  response.writeHead(200, {
    'content-type': safeMimeType(metadata.value.mimeType),
    'content-length': String(content.value.byteLength),
    'x-novakai-artifact-id': metadata.value.id,
    'cache-control': 'no-store',
  });
  response.end(Buffer.from(content.value));
  return true;
}

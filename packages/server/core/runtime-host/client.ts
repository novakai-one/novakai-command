// A minimal nvk-ws v1 client for the CLIs and the second-host harness.
//
// It speaks only the published frame and only published methods — which is what
// makes the second-host proof mean something (§24.4).
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { b3fail, mintClientOpId, type B3ClientOpId, type B3Result } from '@novakai/foundation/contract';
import { PROTOCOL_VERSION, WS_TOKEN_FILE, type ResponseFrame } from '../../contract/protocol.js';

/** The nvk-ws v1 socket-frame version key. Named because it is one letter. */
const VERSION_FIELD = 'v';

export interface RuntimeClientOptions {
  readonly root: string;
  readonly port: number;
  readonly host?: string;
  readonly token?: string;
  readonly connectTimeoutMs?: number;
  /**
   * An Agent running inside a managed PTY presents the credential the
   * Runtime handed it at launch, so it authenticates as ITSELF rather than as
   * the human who happens to own the machine (DEC-B3V4-05).
   */
  readonly agentRunId?: string;
  readonly runToken?: string;
}

export interface RuntimeClient {
  call<Value>(
    method: string, payload: unknown, clientOpId?: B3ClientOpId,
  ): Promise<B3Result<Value>>;
  /** Raw send, so a test can prove a foreign dialect is refused. */
  sendRaw(frame: unknown): Promise<ResponseFrame>;
  onEvent(listener: (name: string, data: unknown) => void): void;
  close(): void;
}

export function readRuntimeToken(root: string): string | null {
  const file = path.join(root, WS_TOKEN_FILE);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf8').trim();
}

export async function connectRuntime(options: RuntimeClientOptions): Promise<RuntimeClient> {
  const token = options.token ?? readRuntimeToken(options.root);
  if (token === null) {
    throw new Error(`no runtime token under ${options.root}; is the runtime running?`);
  }
  const host = options.host ?? '127.0.0.1';
  // Half a credential is a BROKEN credential, not an absent one. Suppressing
  // the whole identity when one field is missing is how a managed Run used to
  // arrive at the door claiming nothing — and a caller claiming nothing is the
  // local human, who holds every scope Chris does (NVK-KIMI-028 finding 1).
  if ((options.agentRunId === undefined) !== (options.runToken === undefined)) {
    throw new Error(
      'an Agent-Run credential needs both agentRunId and runToken; '
      + 'connecting with one half would authenticate as the human',
    );
  }
  const identity = options.agentRunId === undefined || options.runToken === undefined
    ? ''
    : `&agentRunId=${encodeURIComponent(options.agentRunId)}`
      + `&runToken=${encodeURIComponent(options.runToken)}`;
  const socket = new WebSocket(`ws://${host}:${options.port}/ws?token=${token}${identity}`);
  const pending = new Map<number, (frame: ResponseFrame) => void>();
  const listeners: ((name: string, data: unknown) => void)[] = [];
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out connecting to the runtime on port ${options.port}`)),
      options.connectTimeoutMs ?? 5_000,
    );
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
  });

  socket.on('message', (payload) => {
    let frame: unknown;
    try {
      frame = JSON.parse(String(payload));
    } catch {
      return;
    }
    const event = frame as { type?: string; name?: string; data?: unknown };
    if (event.type === 'event' && typeof event.name === 'string') {
      for (const listener of listeners) listener(event.name, event.data);
      return;
    }
    const response = frame as ResponseFrame;
    const settle = pending.get(response.id);
    if (settle) {
      pending.delete(response.id);
      settle(response);
    }
  });

  /** The v1 request frame. `v` is the wire field name, so it is set by key. */
  function requestFrame(
    requestId: number, method: string, params: unknown,
  ): Record<string, unknown> {
    return { id: requestId, method, params, [VERSION_FIELD]: PROTOCOL_VERSION };
  }

  function send(frame: Record<string, unknown>, requestId: number): Promise<ResponseFrame> {
    return new Promise<ResponseFrame>((resolve) => {
      pending.set(requestId, resolve);
      socket.send(JSON.stringify(frame));
    });
  }

  return {
    async call<Value>(method: string, payload: unknown, clientOpId?: B3ClientOpId) {
      const id = nextId;
      nextId += 1;
      const response = await send(requestFrame(id, method, {
        contractVersion: 1,
        clientOpId: clientOpId ?? mintClientOpId(),
        payload,
      }), id);
      if (response.error !== undefined) {
        const detail = typeof response.error === 'string'
          ? response.error : response.error.message;
        return b3fail({
          code: 'RuntimeUnavailable' as const,
          message: detail,
          details: { reason: 'transport-error' },
          retryable: false,
        });
      }
      return response.result as B3Result<Value>;
    },

    async sendRaw(frame: unknown) {
      const record = frame as Record<string, unknown>;
      const id = typeof record['id'] === 'number' ? record['id'] as number : nextId;
      nextId = Math.max(nextId, id) + 1;
      return send({ ...record, id }, id);
    },

    onEvent(listener) { listeners.push(listener); },
    close() { socket.close(); },
  };
}

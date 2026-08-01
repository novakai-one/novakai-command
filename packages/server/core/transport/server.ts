// packages/server/core/transport/server.ts — HTTP + nvk-ws v1 on ONE port
// (DEC-B1-9). Replaces the demo's two-port vite + WS harness.
//
// Security posture (spec §7, stated honestly): the loopback bind is the real
// boundary. The connection token deters stray/accidental local clients — any
// local process that can GET the page can read the token. That matches the
// single-human v1 trust model; it is not an adversary defence.
//
// Red gate 4 is structural here: the host is a constant, not an option, and the
// upgrade is refused with 401 before a socket exists — so no method can be
// dispatched by an unauthenticated caller.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BOOTSTRAP_PATH, PROTOCOL_VERSION, WS_PATH, WS_TOKEN_FILE,
  type BootstrapDocument, type CallerIdentity, type EventFrame, type MethodTable,
  type RequestFrame, type ResponseFrame,
} from '../../contract/protocol.js';
import type { ArtifactsHost } from '../../../artifacts/contract/index.js';
import { handleArtifactHttpRequest } from '../b2a/artifact-http.js';

/** Red gate 4: not configurable. The server never listens off loopback. */
const HOST = '127.0.0.1';

export interface StartTransportOptions {
  /** `.novakai/` root — the ws-token lives under it. */
  root: string;
  port: number;
  /** Directory holding the built shell bundle. Omitted = API only. */
  staticDir?: string;
  methods: MethodTable;
  /** B2a: the sole network adapter allowed to carry Artifact bytes. */
  artifacts?: Pick<ArtifactsHost, 'operations' | 'http'>;
  /** Internal Artifact HTTP adapter override for bounded tests. */
  artifactMaxUploadBytes?: number;
  /** Called for every dispatched method (boot tracing / supervision). */
  onDispatch?(event: DispatchedCall): void;
  /**
   * A connection went away. §13.4: closing a socket is detach, so whoever
   * composed this transport is the only thing that can honour it — the socket
   * is the one fact this layer owns.
   */
  onDisconnect?(connectionId: number): void;
  /**
   * Who a connection is, decided at the UPGRADE from what it presented.
   * Returning `null` refuses the socket outright — an unrecognised claim never
   * becomes a weaker identity, it becomes no connection at all.
   */
  authenticate?(url: URL): CallerIdentity | null;
}

export interface DispatchedCall {
  readonly method: string;
  /** Which connection asked, so per-connection state can be tracked. */
  readonly connectionId: number;
  /** Whatever the method returned, already awaited. */
  readonly result: unknown;
}

export interface RunningTransport {
  /** `http://127.0.0.1:<port>` */
  url: string;
  port: number;
  address: string;
  token: string;
  broadcast(name: string, data: unknown): void;
  connections(): number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

/** Mint the connection token and persist it 0600 for CLI clients. */
function writeToken(root: string): string {
  const token = randomBytes(32).toString('hex');
  const file = path.join(root, WS_TOKEN_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode without this
  return token;
}

export async function startTransport(options: StartTransportOptions): Promise<RunningTransport> {
  const token = writeToken(options.root);
  const staticRoot = options.staticDir ? path.resolve(options.staticDir) : null;
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true });

  const serveFile = (res: ServerResponse, file: string): void => {
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  };

  let http: Server;
  const serveRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (
      options.artifacts
      && await handleArtifactHttpRequest({
        request: req,
        response: res,
        token,
        artifacts: options.artifacts,
        maxUploadBytes: options.artifactMaxUploadBytes,
      })
    ) {
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname === BOOTSTRAP_PATH) {
      const body: BootstrapDocument = {
        wsUrl: `ws://${HOST}:${(http.address() as { port: number }).port}${WS_PATH}`,
        token,
        protocolVersion: PROTOCOL_VERSION,
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    if (!staticRoot) { res.writeHead(404).end('not found'); return; }

    // Resolve inside the bundle only — a path that escapes it is not served.
    const requested = path.resolve(staticRoot, `.${path.posix.normalize(url.pathname)}`);
    const inside = requested === staticRoot || requested.startsWith(staticRoot + path.sep);
    if (inside && existsSync(requested) && statSync(requested).isFile()) {
      serveFile(res, requested);
      return;
    }
    const index = path.join(staticRoot, 'index.html');
    if (existsSync(index)) { serveFile(res, index); return; } // SPA route fallback
    res.writeHead(404).end('not found');
  };
  http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void serveRequest(req, res).catch((cause: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
      }
      res.end(JSON.stringify({
        code: 'ArtifactHttpFailure',
        message: cause instanceof Error ? cause.message : String(cause),
      }));
    });
  });

  // Auth happens at the UPGRADE, so an unauthenticated caller never gets a
  // socket, let alone a method dispatch.
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // B3b: an Agent may present its Run credential on the same socket. A claim
    // that does not verify is refused here — it must never fall back to being
    // treated as the local human.
    const identity = options.authenticate?.(url) ?? { kind: 'human' as const };
    if (identity === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, identity));
  });

  let nextConnectionId = 1;
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, identity?: CallerIdentity) => {
    const connectionId = nextConnectionId;
    nextConnectionId += 1;
    const session = { connectionId, identity: identity ?? { kind: 'human' as const } };
    sockets.add(ws);
    ws.on('close', () => {
      sockets.delete(ws);
      options.onDisconnect?.(connectionId);
    });
    ws.on('message', async (raw) => {
      let frame: RequestFrame;
      try { frame = JSON.parse(String(raw)) as RequestFrame; } catch { return; }
      if (typeof frame?.id !== 'number' || typeof frame?.method !== 'string') return;
      const reply = (payload: Omit<ResponseFrame, 'v'>): void =>
        ws.send(JSON.stringify({ ...payload, v: PROTOCOL_VERSION } satisfies ResponseFrame));

      // AMD-001 A-02: one dialect on this socket. A JSON-RPC 2.0 frame is
      // shaped enough like ours to dispatch by accident, which is exactly how
      // a second protocol gets in. It is refused by name.
      if ((frame as { jsonrpc?: unknown }).jsonrpc !== undefined) {
        reply({
          id: frame.id,
          error: {
            code: 'UnsupportedProtocolVersion',
            message: 'this socket speaks nvk-ws v1; JSON-RPC 2.0 framing is not accepted',
            details: {
              received: (frame as { jsonrpc?: unknown }).jsonrpc,
              supported: [PROTOCOL_VERSION],
            },
            retryable: false,
          },
        });
        return;
      }

      if (frame.v !== undefined && frame.v !== PROTOCOL_VERSION) {
        reply({
          id: frame.id,
          error: {
            code: 'UnsupportedProtocolVersion',
            message:
              `protocol version ${String(frame.v)} is not supported; `
              + `expected ${PROTOCOL_VERSION}`,
            details: {
              received: frame.v,
              supported: [PROTOCOL_VERSION],
            },
            retryable: false,
          },
        });
        return;
      }
      const handler = options.methods[frame.method];
      if (!handler) { reply({ id: frame.id, error: `unknown method ${frame.method}` }); return; }
      try {
        const result = await handler(frame.params as never, session);
        options.onDispatch?.({ method: frame.method, connectionId, result });
        reply({ id: frame.id, result });
      } catch (cause) {
        reply({ id: frame.id, error: cause instanceof Error ? cause.message : String(cause) });
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port, HOST, resolve));
  const port = (http.address() as { port: number }).port;

  return {
    url: `http://${HOST}:${port}`,
    port,
    address: HOST,
    token,
    broadcast(name, data) {
      const frame: EventFrame = { type: 'event', name, data, v: PROTOCOL_VERSION };
      const payload = JSON.stringify(frame);
      for (const ws of sockets) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },
    connections: () => sockets.size,
    async close() {
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

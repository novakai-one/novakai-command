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
  type BootstrapDocument, type EventFrame, type MethodTable, type RequestFrame, type ResponseFrame,
} from '../../contract/protocol.js';

/** Red gate 4: not configurable. The server never listens off loopback. */
const HOST = '127.0.0.1';

export interface StartTransportOptions {
  /** `.novakai/` root — the ws-token lives under it. */
  root: string;
  port: number;
  /** Directory holding the built shell bundle. Omitted = API only. */
  staticDir?: string;
  methods: MethodTable;
  /** Called for every dispatched method (boot tracing / supervision). */
  onDispatch?(method: string): void;
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

  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', async (raw) => {
      let frame: RequestFrame;
      try { frame = JSON.parse(String(raw)) as RequestFrame; } catch { return; }
      if (typeof frame?.id !== 'number' || typeof frame?.method !== 'string') return;
      const reply = (payload: Omit<ResponseFrame, 'v'>): void =>
        ws.send(JSON.stringify({ ...payload, v: PROTOCOL_VERSION } satisfies ResponseFrame));

      const handler = options.methods[frame.method];
      if (!handler) { reply({ id: frame.id, error: `unknown method ${frame.method}` }); return; }
      options.onDispatch?.(frame.method);
      try {
        reply({ id: frame.id, result: await handler(frame.params as never) });
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

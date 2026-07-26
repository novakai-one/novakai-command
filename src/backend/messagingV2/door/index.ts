/**
 * messagingV2 door (D-N6-1): the DEC-17 frames-protocol endpoint INSIDE the
 * app backend — a third HTTP/WS listener (default port 3032, bind 127.0.0.1;
 * remote reachability is the owner's opt-in) serving the package's
 * createProtocolConnection against the app's EXISTING embedded stack. Local
 * agent lanes stay 'pty' (terminal host); external connections OpenPresence
 * with 'ws' and get real push — the ws presence transport is registered
 * ALONGSIDE the pty transport (Seams §4: registered kinds only).
 *
 * Reference wiring: packages/messaging/composition/standalone.ts:184-211 —
 * the same accept → createProtocolConnection → handleText/handleClose flow,
 * and the same close order (F2: live sockets first, then server.close).
 */
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { EmbeddedMessaging } from '../../../../packages/messaging/composition/embedded.js';
import type { CoreStack } from '../../../../packages/messaging/composition/coreStack.js';
import { createProtocolConnection } from '../../../../packages/messaging/protocol/connection.js';
import type { ServerFrame } from '../../../../packages/messaging/protocol/frames.js';
import { createWsPresenceTransport } from '../../../../packages/messaging/adapters/presence-transport-ws.js';
import type { WsPresenceTransport } from '../../../../packages/messaging/adapters/presence-transport-ws.js';

export interface DoorOptions {
  /** 0 = ephemeral (tests); the resolved port lands on the handle. */
  port: number;
  host?: string;
}

export interface MessagingDoor {
  readonly port: number;
  close(): Promise<void>;
}

/** The registered 'ws' presence transport for the embedded stack (the door
 * owns accept/bind/push over the same instance). */
export function createDoorTransport(): WsPresenceTransport {
  return createWsPresenceTransport();
}

/** The embedded root doesn't re-expose its CoreStack — the door needs only
 * authenticate/capabilities/registry, all public on EmbeddedMessaging. The
 * versions agree (EMBEDDED_PROTOCOL_VERSION === WS_PROTOCOL_VERSION), so the
 * capabilities the door serves ARE the wire truth. */
function doorStack(embedded: EmbeddedMessaging): CoreStack {
  return {
    authenticate: (credential: unknown) => embedded.authenticate(credential),
    capabilities: () => embedded.getCapabilities(),
    registry: embedded.registry,
  } as unknown as CoreStack;
}

/** Outbound frames — a dead socket mid-send is the close event's job. */
function frameSender(socket: WebSocket): (frame: ServerFrame) => void {
  return (frame) => {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // The socket died mid-send — the close event drives teardown.
    }
  };
}

function closeOnce(socket: WebSocket): void {
  try {
    socket.close(1000, 'session ended');
  } catch {
    // Already closing — the close event drives teardown.
  }
}

/** One DEC-17 connection: accept into the ws transport, wire the protocol
 * connection (the standalone.ts:184-211 reference flow). */
function acceptConnection(embedded: EmbeddedMessaging, transport: WsPresenceTransport, socket: WebSocket): void {
  transport.accept(socket);
  const connection = createProtocolConnection({
    stack: doorStack(embedded),
    send: frameSender(socket),
    bindPresence: (presenceId) => transport.bind(presenceId, socket),
    pushSinkFor: (presenceId) => (frame) => transport.push(presenceId, frame),
    closeConnection: () => closeOnce(socket),
  });
  socket.on('message', (data: Buffer) => {
    void connection.handleText(data.toString('utf8'));
  });
  socket.on('close', () => {
    void connection.handleClose();
  });
}

async function listen(server: WebSocketServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (error) => reject(error));
  });
  return (server.address() as AddressInfo).port;
}

export async function startDoor(
  embedded: EmbeddedMessaging,
  transport: WsPresenceTransport,
  options: DoorOptions,
): Promise<MessagingDoor> {
  const server = new WebSocketServer({ port: options.port, host: options.host ?? '127.0.0.1' });
  const port = await listen(server);
  server.on('connection', (socket) => acceptConnection(embedded, transport, socket));
  return {
    port,
    async close(): Promise<void> {
      // F2 (the standalone order is load-bearing): close live sockets FIRST —
      // server.close() never fires its callback while clients are connected.
      await transport.closeAll();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

// packages/server/contract/protocol.ts — nvk-ws v1 (DEC-B1-9).
//
// The demo's WS JSON-RPC shape is PROMOTED, not redesigned: the shell's
// bridgeClient already speaks it. v1 only adds the `v` field, which is additive
// (A §19 additive-only versioning): an omitted request `v` is legacy v1, while
// a present value other than 1 is rejected before method dispatch with a typed
// UnsupportedProtocolVersion error. Old clients therefore remain compatible.
//
//   request   { id, method, params?, v: 1 }
//   response  { id, result | error, v: 1 }
//   event     { type: 'event', name, data, v: 1 }
//
// Transport facts a client must know:
//   - the socket lives at `/ws` on the SAME port as the shell bundle;
//   - it is loopback-only (127.0.0.1) — that bind is the real security boundary;
//   - every connection carries `?token=<ws-token>`; without it the upgrade is
//     refused with 401 before any method can dispatch (red gate 4).

export const PROTOCOL_VERSION = 1;

/** Where the page fetches its connection facts (same-origin). */
export const BOOTSTRAP_PATH = '/bootstrap.json';
/** Where the WS upgrade happens. */
export const WS_PATH = '/ws';
/** The token file the server writes (mode 600) for CLI clients. */
export const WS_TOKEN_FILE = 'server/ws-token';

export interface RequestFrame {
  id: number;
  method: string;
  params?: unknown;
  /** Omitted means legacy v1; any present unsupported value is rejected. */
  v?: number;
}

export interface UnsupportedProtocolVersionError {
  code: 'UnsupportedProtocolVersion';
  message: string;
  details: {
    received: unknown;
    supported: Array<typeof PROTOCOL_VERSION>;
  };
  retryable: false;
}

export interface ResponseFrame {
  id: number;
  result?: unknown;
  error?: string | UnsupportedProtocolVersionError;
  v: typeof PROTOCOL_VERSION;
}

export interface EventFrame {
  type: 'event';
  name: string;
  data: unknown;
  v: typeof PROTOCOL_VERSION;
}

/**
 * What code this server process is running. Written by `nvk deploy` as
 * release.json at the snapshot root; absent (null) when the server runs a
 * working checkout directly — i.e. a dev/scratch boot, never the live serve.
 */
export interface ReleaseStamp {
  commit: string;
  branch: string;
  builtAt: string;
  /** The checkout had uncommitted changes when the snapshot was taken. */
  dirty: boolean;
  /** The checkout the snapshot was cloned from. */
  source: string;
}

/** GET /bootstrap.json — everything a client needs to open the socket. */
export interface BootstrapDocument {
  wsUrl: string;
  token: string;
  protocolVersion: number;
  /** Additive: absent on pre-deploy servers, null on unstamped (dev) boots. */
  release?: ReleaseStamp | null;
}

/**
 * Who is on the other end of a connection.
 *
 * B3 clients may connect from inside an Agent's managed PTY, so "the caller"
 * is not always one local human. Identity is resolved at the UPGRADE
 * from what the connection presented and travels with the dispatch — it is
 * never read out of `params`, because a caller that can name its own identity
 * can name its own parent (red gate 5).
 */
export type CallerIdentity =
  | { readonly kind: 'human' }
  | { readonly kind: 'agent-run'; readonly agentRunId: string };

export interface CallerSession {
  readonly connectionId: number;
  readonly identity: CallerIdentity;
}

/**
 * One WS method: params in, JSON-serializable value out.
 *
 * `session` is additive and optional, so every pre-B3b handler — which declares
 * one parameter — remains assignable unchanged.
 */
export type MethodHandler = (params: never, session?: CallerSession) => Promise<unknown>;
export type MethodTable = Record<string, MethodHandler>;

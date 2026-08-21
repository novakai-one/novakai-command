// packages/server/core/door/routes.ts — the HTTP door on the one :5180 server.
//
// Same posture as the transport it plugs into: loopback is the boundary, the
// bearer decides WHO. Two credential classes, never interchangeable:
//   • a principal bearer (nvk_…)   → an agent acting as itself (send/read)
//   • the connection token          → a local process acting for Chris
//     (register, roster, user verbs — the Slack bridge)
// An unauthenticated request is refused with a named error and nothing stored.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MethodTable } from '../../contract/protocol.js';
import type { ServerRuntime } from '../methods.js';
import type { ProviderName } from '../../contract/config.js';
import {
  addressBook, agentMessages, agentSend, principalForBearer, type DoorPrincipal,
} from './messages.js';
import { registerExternalAgent } from './provision.js';
import { roster, userMessages, userSend, userThreads } from './user.js';

const MAX_BODY_BYTES = 256 * 1024;
const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'kimi', 'mock']);

export interface DoorRequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** The transport's connection token — the local-process credential. */
  connectionToken: string;
}

export interface DoorDeps {
  runtime: ServerRuntime;
  methods: MethodTable;
}

interface DoorCall {
  deps: DoorDeps;
  request: IncomingMessage;
  response: ServerResponse;
  requestUrl: URL;
  bearer: string | null;
  connectionToken: string;
}

const respond = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};

const bearerOf = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
};

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The local-process credential, or a 401 already written. */
function requireLocalProcess(call: DoorCall): boolean {
  if (call.bearer === call.connectionToken) return true;
  respond(call.response, 401, { error: 'this verb needs the connection token (.novakai/server/ws-token)' });
  return false;
}

/** The agent's own principal, or a 401 already written. */
function requirePrincipal(call: DoorCall): DoorPrincipal | null {
  const principal = call.bearer ? principalForBearer(call.deps.runtime, call.bearer) : null;
  if (!principal) {
    respond(call.response, 401, { error: 'no valid identity token — register first or check NVK_AGENT_TOKEN' });
  }
  return principal;
}

// ── agent-side verbs (principal bearer) ────────────────────────────────────

async function handleAddressBook(call: DoorCall): Promise<void> {
  const principal = requirePrincipal(call);
  if (principal) respond(call.response, 200, await addressBook(call.deps.runtime));
}

async function handleAgentSend(call: DoorCall): Promise<void> {
  const principal = requirePrincipal(call);
  if (!principal) return;
  const body = await readJsonBody(call.request);
  if (!body || typeof body.to !== 'string' || typeof body.body !== 'string' || !body.body.trim()) {
    respond(call.response, 400, { error: 'expected {to, body} with a non-empty body' });
    return;
  }
  const sent = await agentSend(call.deps.runtime, principal, {
    to: body.to,
    body: body.body,
    interrupt: body.interrupt === true,
    ...(typeof body.clientMessageId === 'string' ? { clientMessageId: body.clientMessageId } : {}),
  });
  if (sent.ok) {
    respond(call.response, 200, {
      ok: true, messageId: sent.messageId, ...(sent.urgentDowngraded ? { urgentDowngraded: true } : {}),
    });
  } else {
    respond(call.response, sent.status, { error: sent.error });
  }
}

async function handleAgentMessages(call: DoorCall): Promise<void> {
  const principal = requirePrincipal(call);
  if (!principal) return;
  const withName = call.requestUrl.searchParams.get('with');
  if (!withName) {
    respond(call.response, 400, { error: 'expected ?with=<name>' });
    return;
  }
  const result = await agentMessages(call.deps.runtime, principal, withName);
  if (result.ok) respond(call.response, 200, { messages: result.messages });
  else respond(call.response, result.status, { error: result.error });
}

// ── local-process verbs (connection token) ─────────────────────────────────

async function handleRegister(call: DoorCall): Promise<void> {
  if (!requireLocalProcess(call)) return;
  const body = await readJsonBody(call.request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  if (!name || !PROVIDERS.has(provider)) {
    respond(call.response, 400, { error: 'expected {name, provider: claude|codex|kimi|mock}' });
    return;
  }
  try {
    const registered = await registerExternalAgent(call.deps.runtime, name, provider as ProviderName);
    respond(call.response, 200, { ok: true, ...registered });
  } catch (cause) {
    respond(call.response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
  }
}

async function handleRoster(call: DoorCall): Promise<void> {
  if (requireLocalProcess(call)) respond(call.response, 200, await roster(call.deps.runtime));
}

async function handleUserThreads(call: DoorCall): Promise<void> {
  if (requireLocalProcess(call)) respond(call.response, 200, await userThreads(call.deps.runtime));
}

async function handleUserMessages(call: DoorCall): Promise<void> {
  if (!requireLocalProcess(call)) return;
  const threadId = call.requestUrl.searchParams.get('threadId');
  if (!threadId) {
    respond(call.response, 400, { error: 'expected ?threadId=' });
    return;
  }
  respond(call.response, 200, await userMessages(call.deps.runtime, threadId));
}

/** The bridge sends body as {text}; older callers send a bare string. */
function textOfBody(rawBody: unknown): string {
  if (typeof rawBody === 'string') return rawBody;
  const nested = (rawBody as { text?: unknown })?.text;
  return typeof nested === 'string' ? nested : '';
}

async function handleUserSend(call: DoorCall): Promise<void> {
  if (!requireLocalProcess(call)) return;
  const body = await readJsonBody(call.request);
  const toName = typeof body?.to === 'string' ? body.to : '';
  const text = textOfBody(body?.body);
  if (!toName || !text.trim()) {
    respond(call.response, 400, { error: 'expected {to, body}' });
    return;
  }
  const sent = await userSend(call.deps.runtime, call.deps.methods, toName, text);
  if (sent.ok) respond(call.response, 200, { ok: true, ...(sent.messageId ? { messageId: sent.messageId } : {}) });
  else respond(call.response, sent.status, { error: sent.error, ...(sent.roster ? { roster: sent.roster } : {}) });
}

const ROUTES: Record<string, (call: DoorCall) => Promise<void>> = {
  'GET /api/door/address-book': handleAddressBook,
  'POST /api/door/send': handleAgentSend,
  'GET /api/door/messages': handleAgentMessages,
  'POST /api/door/register': handleRegister,
  'GET /api/door/agents': handleRoster,
  'GET /api/door/user/threads': handleUserThreads,
  'GET /api/door/user/messages': handleUserMessages,
  'POST /api/door/user/send': handleUserSend,
};

/**
 * Handle one door request. Returns false when the path is not the door's —
 * the transport then falls through to bootstrap/static, exactly like the
 * artifact HTTP adapter.
 */
export async function handleDoorHttpRequest(
  deps: DoorDeps, context: DoorRequestContext,
): Promise<boolean> {
  const { request, response, connectionToken } = context;
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!requestUrl.pathname.startsWith('/api/door/')) return false;
  const route = `${request.method} ${requestUrl.pathname}`;
  const handler = ROUTES[route];
  if (!handler) {
    respond(response, 404, { error: `unknown door route ${route}` });
    return true;
  }
  await handler({ deps, request, response, requestUrl, bearer: bearerOf(request), connectionToken });
  return true;
}

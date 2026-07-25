/**
 * messagingV2 REST routes (slice N2 — Agent direct lane): the authenticated
 * v2 surface the rewritten nvk-msg CLI talks to. Registered alongside the
 * surviving old routes (the human lane, rooms, history reads — N3/N4).
 *
 * THREAT DECISION (N1 audit finding 3, decided here): the credential token IS
 * the durable agentId — an identifier, not a secret, observable in rosters,
 * logs, and the object model. That is acceptable ONLY inside the local
 * same-user trust boundary: this server binds 127.0.0.1, every caller is a
 * PTY the same user spawned, and the token is server-injected into the child
 * env (NVK_AGENT_ID), never printed. Real token issuance arrives with N6;
 * nothing outside localhost may ever be pointed at these routes before then.
 *
 * Auth: `Authorization: Bearer <token>` → embedded.authenticate({ token }).
 * Sessions are cached per token (§2.1 revalidation lives inside the session
 * wrapper); a NotAuthenticated outcome evicts the cached entry. Rejected or
 * capability-unavailable → 401; the capability down → 503.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { MessagingError, PersonId, Thread, ThreadId } from '../../../../packages/messaging/public/contract/index.js';
import type { MessagingSession, Outcome } from '../../../../packages/messaging/public/capability.js';
import { isChannel, isRoom } from '../../messaging/types.js';
import type { ObjectModel } from '../../objectModel/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import type { MessagingV2Handle } from '../index.js';
import { personIdForAgentId } from '../authority/index.js';

export interface MessagingV2RouteDeps {
  /** Lazy: the capability boots asynchronously AFTER routes are registered. */
  getHandle: () => MessagingV2Handle | null;
  terminals: TerminalRuntime;
  objectModel: ObjectModel;
}

type SessionCache = Map<string, MessagingSession>;
type AuthResult = { session: MessagingSession; token: string } | { status: number; error: string };

interface SendBody {
  target: string;
  text: string;
  interrupt: boolean;
  clientMessageId: string;
}

function bearerToken(request: Request): string | undefined {
  const header = request.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
  return token === '' ? undefined : token;
}

async function authFor(deps: MessagingV2RouteDeps, cache: SessionCache, request: Request): Promise<AuthResult> {
  const token = bearerToken(request);
  if (token === undefined) return { status: 401, error: 'missing Authorization: Bearer <token>' };
  const cached = cache.get(token);
  if (cached !== undefined) return { session: cached, token };
  const handle = deps.getHandle();
  if (handle === null) return { status: 503, error: 'messaging capability unavailable this run' };
  const outcome = await handle.embedded.authenticate({ token });
  if (outcome.kind === 'rejected') return { status: 401, error: outcome.error.message };
  if (outcome.kind === 'unavailable') return { status: 503, error: outcome.error.message };
  cache.set(token, outcome.session);
  return { session: outcome.session, token };
}

function statusForError(error: MessagingError): number {
  switch (error.name) {
    case 'NotAuthenticated': return 401;
    case 'NotAuthorized': case 'BlockedByContactPolicy': return 403;
    case 'UnknownRecipient': case 'UnknownThread': case 'UnknownMessage': return 404;
    case 'ValidationFailed': return 400;
    case 'DependencyUnavailable': return 503;
    default: return 500;
  }
}

/** Reply with the ok value at 200, or the mapped error; evicts dead sessions. */
function reply<T>(cache: SessionCache, token: string, response: Response, outcome: Outcome<T>): void {
  if (outcome.kind === 'ok') {
    response.status(200).json(outcome.value);
    return;
  }
  if (outcome.error.name === 'NotAuthenticated') cache.delete(token);
  response.status(statusForError(outcome.error)).json({ error: outcome.error.message, name: outcome.error.name });
}

/** display name → live agent (only running PTYs are addressable, §5). */
function resolvePeer(terminals: TerminalRuntime, name: string): AgentInfo | undefined {
  return listRunning(terminals).find((agent) => agent.title === name);
}

function listRunning(terminals: TerminalRuntime): AgentInfo[] {
  return terminals.list().filter((agent) => agent.status === 'running');
}

function parseSendBody(payload: unknown): SendBody | string {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
  if (typeof record['to'] !== 'string' || record['to'].trim() === '') return 'to must be a non-empty string';
  if (typeof record['body'] !== 'string' || record['body'].trim() === '') return 'body must be a non-empty string';
  const clientMessageId = typeof record['clientMessageId'] === 'string' && record['clientMessageId'] !== ''
    ? record['clientMessageId'] : `msg_${randomUUID()}`;
  return { target: record['to'], text: record['body'], interrupt: record['interrupt'] === true, clientMessageId };
}

/** Authenticate or answer the error: null means the response is already sent. */
async function sessionOrReply(
  deps: MessagingV2RouteDeps,
  cache: SessionCache,
  request: Request,
  response: Response,
): Promise<{ session: MessagingSession; token: string } | null> {
  const auth = await authFor(deps, cache, request);
  if ('session' in auth) return auth;
  response.status(auth.status).json({ error: auth.error });
  return null;
}

/** The live peer, or a 404 already sent (null). */
function peerOrReply(terminals: TerminalRuntime, name: string, response: Response): AgentInfo | null {
  const peer = resolvePeer(terminals, name);
  if (peer !== undefined) return peer;
  response.status(404).json({ error: `no live agent named "${name}"` });
  return null;
}

function sendInputFor(parsed: SendBody, peer: AgentInfo): Record<string, unknown> {
  return {
    address: `person:${personIdForAgentId(peer.agentId)}`,
    body: { text: parsed.text },
    priority: parsed.interrupt ? 'urgent' : 'normal',
    clientMessageId: parsed.clientMessageId,
  };
}

async function handleSend(deps: MessagingV2RouteDeps, cache: SessionCache, request: Request, response: Response): Promise<void> {
  const auth = await sessionOrReply(deps, cache, request, response);
  if (auth === null) return;
  const parsed = parseSendBody(request.body);
  if (typeof parsed === 'string') {
    response.status(400).json({ error: parsed });
    return;
  }
  if (isChannel(parsed.target) || isRoom(parsed.target)) {
    response.status(400).json({ error: 'rooms and channels land in N3 — #team is read-only for agents' });
    return;
  }
  const peer = peerOrReply(deps.terminals, parsed.target, response);
  if (peer === null) return;
  reply(cache, auth.token, response, await auth.session.sendMessage(sendInputFor(parsed, peer)));
}

async function handleInbox(deps: MessagingV2RouteDeps, cache: SessionCache, request: Request, response: Response): Promise<void> {
  const auth = await sessionOrReply(deps, cache, request, response);
  if (auth === null) return;
  reply(cache, auth.token, response, await auth.session.getInbox({}));
}

/** The direct Thread between the caller and `peerPerson`, if one exists. */
function directThreadId(threads: Thread[], self: PersonId, peer: PersonId): ThreadId | undefined {
  const found = threads.find((thread) =>
    thread.threadKind === 'direct' && thread.direct !== undefined
    && thread.direct.pair.includes(self) && thread.direct.pair.includes(peer));
  return found?.id;
}

/** The with=<name> query param, or a 400 already sent (null). */
function withParam(request: Request, response: Response): string | null {
  const withName = request.query['with'];
  if (typeof withName === 'string' && withName.trim() !== '') return withName;
  response.status(400).json({ error: 'with=<name> is required' });
  return null;
}

/** Thread resolution + paged read for ?with=<name>, as an HTTP-ready result. */
async function messagesResult(session: MessagingSession, peer: AgentInfo): Promise<{ status: number; payload: Record<string, unknown> }> {
  const threads = await session.listThreadsForPerson({});
  if (threads.kind !== 'ok') return { status: statusForError(threads.error), payload: { error: threads.error.message } };
  const threadId = directThreadId(threads.value.threads, session.principal.personId, personIdForAgentId(peer.agentId));
  if (threadId === undefined) return { status: 200, payload: { threadId: null, messages: [] } };
  const page = await session.getMessages({ threadId });
  if (page.kind !== 'ok') return { status: statusForError(page.error), payload: { error: page.error.message } };
  return { status: 200, payload: { threadId, messages: page.value.messages } };
}

async function handleMessages(deps: MessagingV2RouteDeps, cache: SessionCache, request: Request, response: Response): Promise<void> {
  const auth = await sessionOrReply(deps, cache, request, response);
  if (auth === null) return;
  const withName = withParam(request, response);
  if (withName === null) return;
  const peer = peerOrReply(deps.terminals, withName, response);
  if (peer === null) return;
  const result = await messagesResult(auth.session, peer);
  response.status(result.status).json(result.payload);
}

async function handleAddressBook(deps: MessagingV2RouteDeps, cache: SessionCache, request: Request, response: Response): Promise<void> {
  const auth = await sessionOrReply(deps, cache, request, response);
  if (auth === null) return;
  response.status(200).json({ agents: addressBook(deps) });
}

function addressBook(deps: MessagingV2RouteDeps): Array<Record<string, unknown>> {
  return listRunning(deps.terminals).map((agent) => ({
    name: agent.title,
    agentId: agent.agentId,
    personId: personIdForAgentId(agent.agentId),
    provider: agent.provider,
    status: durableStatus(deps.objectModel, agent.agentId),
  }));
}

function durableStatus(objectModel: ObjectModel, agentId: string): string | null {
  try {
    return objectModel.agentRecord(agentId)?.status ?? null;
  } catch {
    return null; // a store hiccup must not fail the roster read
  }
}

export function registerMessagingV2Routes(application: Express, deps: MessagingV2RouteDeps): void {
  const cache: SessionCache = new Map();
  application.post('/api/messaging/v2/send', (request, response) => void handleSend(deps, cache, request, response));
  application.get('/api/messaging/v2/inbox', (request, response) => void handleInbox(deps, cache, request, response));
  application.get('/api/messaging/v2/messages', (request, response) => void handleMessages(deps, cache, request, response));
  application.get('/api/messaging/v2/address-book', (request, response) => void handleAddressBook(deps, cache, request, response));
}

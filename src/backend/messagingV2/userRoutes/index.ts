/**
 * messagingV2 server-owned human routes (slice N4 — Frontend, D-N4-3):
 * the browser's send/read surface, through the capability AS the human
 * principal. NO Bearer token — the server IS the trust boundary (the same
 * posture the old /api/user/messages had, now backed by the capability
 * instead of the old router). These routes serve the D-N4-2 data plane;
 * agent-authenticated traffic keeps using ./routes (Bearer = agentId).
 *
 * Error grammar mirrors the old user route's: 400 validation, 404 (+live
 * roster hint) unknown recipient, 403 policy-blocked, 503 capability down.
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import type { MessagingError, ThreadId } from '../../../../packages/messaging/public/contract/index.js';
import type { MessagingSession } from '../../../../packages/messaging/public/capability.js';
import { isChannel, isRoom } from '../../messaging/types.js';
import type { ObjectModel } from '../../objectModel/index.js';
import type { AgentInfo } from '../../terminal/manager.js';
import type { TerminalRuntime } from '../../terminal/runtime/index.js';
import type { MessagingV2Handle } from '../index.js';
import { personIdForAgentId } from '../authority/index.js';
import { readTrailingPage } from '../rooms/index.js';

export interface MessagingV2UserRouteDeps {
  /** Lazy: the capability boots asynchronously AFTER routes are registered. */
  getHandle: () => MessagingV2Handle | null;
  terminals: TerminalRuntime;
  objectModel: ObjectModel;
}

interface SendBody {
  target: string;
  text: string;
  interrupt: boolean;
}

/** The held human session, or a 503 already sent (null). */
function humanOrReply(deps: MessagingV2UserRouteDeps, response: Response): MessagingSession | null {
  const session = deps.getHandle()?.lanes?.humanSession() ?? null;
  if (session !== null) return session;
  response.status(503).json({ error: 'messaging capability unavailable this run' });
  return null;
}

function statusForError(error: MessagingError): number {
  switch (error.name) {
    case 'NotAuthorized': case 'BlockedByContactPolicy': return 403;
    case 'UnknownRecipient': case 'UnknownThread': return 404;
    case 'ValidationFailed': return 400;
    case 'DependencyUnavailable': return 503;
    default: return 500;
  }
}

function parseSendBody(payload: unknown): SendBody | string {
  const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
  if (typeof record['to'] !== 'string' || record['to'].trim() === '') return 'to must be a non-empty string';
  if (typeof record['body'] !== 'string' || record['body'].trim() === '') return 'body must be a non-empty string';
  return { target: record['to'], text: record['body'], interrupt: record['interrupt'] === true };
}

/** display name → personId: the running roster first, then DURABLE agents
 * by name (F9 — an exited-but-durable agent resolves; the capability
 * decides deliverability — delivery pends honestly, matching the UI's
 * openable exited-agent lanes). Mailbox identities that map to durable
 * agents are covered by the same name lookup (their memberName IS the
 * agent's name). Unknown → null (the caller 404s with the roster hint). */
function resolveRecipientPersonId(deps: MessagingV2UserRouteDeps, name: string): string | undefined {
  const running = deps.terminals.list().find((agent) =>
    agent.status === 'running' && agent.title === name && deps.objectModel.agentRecord(agent.agentId) !== null);
  if (running !== undefined) return personIdForAgentId(running.agentId);
  const durable = deps.objectModel.listAgents().find((block) => block.name === name);
  return durable === undefined ? undefined : personIdForAgentId(durable.id);
}

function liveRosterHint(deps: MessagingV2UserRouteDeps): string[] {
  return deps.terminals.list()
    .filter((agent) => agent.status === 'running')
    .map((agent) => agent.title);
}

/** One outcome → HTTP (ok at `okStatus`, errors through the grammar). */
function replyOutcome<T>(response: Response, outcome: { kind: 'ok'; value: T } | { kind: 'error'; error: MessagingError }, okStatus: number): void {
  if (outcome.kind === 'ok') {
    response.status(okStatus).json(outcome.value);
    return;
  }
  response.status(statusForError(outcome.error)).json({ error: outcome.error.message, name: outcome.error.name });
}

/** A 400 already sent (null return for the guard shape). */
function badRequest(response: Response, message: string): null {
  response.status(400).json({ error: message });
  return null;
}

/** A `#…` target → threadId: label match, then team/mission id match. */
function resolveRoomThread(deps: MessagingV2UserRouteDeps, target: string): ThreadId | undefined {
  const rooms = deps.getHandle()?.rooms ?? null;
  if (rooms === null) return undefined;
  if (target === '#team') return rooms.fleetThreadId();
  const bare = target.slice(1);
  return rooms.threadIdForLabel(target)
    ?? rooms.threadIdFor('team', bare)
    ?? rooms.threadIdFor('mission', bare);
}

function roomInput(parsed: SendBody, threadId: ThreadId): Record<string, unknown> {
  return {
    address: `thread:${threadId}`,
    body: { text: parsed.text },
    priority: 'normal',
    clientMessageId: `msg_${randomUUID()}`,
  };
}

async function sendRoom(
  deps: MessagingV2UserRouteDeps,
  session: MessagingSession,
  parsed: SendBody,
  response: Response,
): Promise<void> {
  if (parsed.interrupt) {
    // Parity with the old channel rule: interrupting a whole room is rejected.
    badRequest(response, 'interrupt delivery is rejected for room recipients');
    return;
  }
  const threadId = resolveRoomThread(deps, parsed.target);
  if (threadId === undefined) {
    response.status(404).json({ error: `no room named "${parsed.target}" (try '#team' or a provisioned #<team/mission name>)` });
    return;
  }
  replyOutcome(response, await session.sendMessage(roomInput(parsed, threadId)), 201);
}

function personInput(parsed: SendBody, personId: string): Record<string, unknown> {
  return {
    address: `person:${personId}`,
    body: { text: parsed.text },
    priority: parsed.interrupt ? 'urgent' : 'normal',
    clientMessageId: `msg_${randomUUID()}`,
  };
}

async function handleUserSend(deps: MessagingV2UserRouteDeps, request: Request, response: Response): Promise<void> {
  const session = humanOrReply(deps, response);
  if (session === null) return;
  const parsed = parseSendBody(request.body);
  if (typeof parsed === 'string') {
    badRequest(response, parsed);
    return;
  }
  if (isChannel(parsed.target) || isRoom(parsed.target)) {
    await sendRoom(deps, session, parsed, response);
    return;
  }
  const personId = resolveRecipientPersonId(deps, parsed.target);
  if (personId === undefined) {
    response.status(404).json({ error: `recipient "${parsed.target}" is not a live agent`, roster: liveRosterHint(deps) });
    return;
  }
  replyOutcome(response, await session.sendMessage(personInput(parsed, personId)), 201);
}

async function handleThreads(deps: MessagingV2UserRouteDeps, response: Response): Promise<void> {
  const session = humanOrReply(deps, response);
  if (session === null) return;
  const outcome = await session.listThreadsForPerson({});
  if (outcome.kind !== 'ok') {
    replyOutcome(response, outcome, 200);
    return;
  }
  // Enrich room threads with their directory label — the D-N4-2 translator
  // derives lane ids from it ('#team', '#<team/mission name>').
  const rooms = deps.getHandle()?.rooms ?? null;
  const threads = outcome.value.threads.map((thread) => {
    const label = rooms?.labelFor(thread.id);
    return label === undefined ? thread : { ...thread, label };
  });
  response.status(200).json({ threads });
}

/** threadId query param, or a 400 already sent (null). */
function threadIdParam(request: Request, response: Response): string | null {
  const threadId = request.query['threadId'];
  if (typeof threadId === 'string' && threadId.trim() !== '') return threadId;
  response.status(400).json({ error: 'threadId=<id> is required' });
  return null;
}

/** The read failure grammar: unknown thread 404, dependency 503, else 500. */
function readFailure(error: unknown, response: Response): void {
  const name = error instanceof Error ? error.name : '';
  const status = name === 'UnknownThread' ? 404 : name === 'DependencyUnavailable' ? 503 : 500;
  response.status(status).json({ error: error instanceof Error ? error.message : String(error), name });
}

async function handleMessages(deps: MessagingV2UserRouteDeps, request: Request, response: Response): Promise<void> {
  const session = humanOrReply(deps, response);
  if (session === null) return;
  const threadId = threadIdParam(request, response);
  if (threadId === null) return;
  try {
    // Trailing window (the D-N4-2 client serves the newest page; the O(pages)
    // cost is recorded in the data-plane header).
    const trailing = await readTrailingPage(session, threadId as ThreadId);
    response.status(200).json({ threadId, messages: trailing });
  } catch (error) {
    readFailure(error, response);
  }
}

export function registerMessagingV2UserRoutes(application: Express, deps: MessagingV2UserRouteDeps): void {
  application.post('/api/messaging/v2/user/send', (request, response) => void handleUserSend(deps, request, response));
  application.get('/api/messaging/v2/user/threads', (_request, response) => void handleThreads(deps, response));
  application.get('/api/messaging/v2/user/messages', (request, response) => void handleMessages(deps, request, response));
}

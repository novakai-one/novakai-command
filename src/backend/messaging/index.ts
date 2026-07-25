// Agent messaging tunnel wiring (docs/agent-messaging.md). Owns the surviving
// REST surface (GET /api/messages history, /api/user/messages, rooms,
// mailboxes), and pushes every appended envelope over the existing WebSocket
// broadcast for the future Messages view (R6). Kept out of server/index.ts
// the same way AgentsHub is.
//
// N2 deletions: POST /api/messages + handleSend (agent-originated sends now
// go through the authenticated v2 routes), and the spawn briefing (the
// messagingV2 presence glue owns it). The router/delivery/confirmer stack
// stays for the human lane until N3/N4.
import type { Express, Request, Response } from 'express';
import type { AgentInfo } from '../terminal/manager.js';
import { rosterFromAgents } from './address/index.js';
import { PtyDelivery, DeliveryFailedError } from './delivery/index.js';
import type { DeliveryTimings, PtyWriter } from './delivery/index.js';
import {
  MessageRouter,
  InterruptRateLimiter,
  RecipientNotFoundError,
  InterruptRateLimitError,
  ChannelInterruptError,
  NotARoomMemberError,
  RoomNotFoundError,
} from './router/index.js';
import { RoomStore } from './rooms/index.js';
import { MailboxConflictError, MailboxRegistry } from './mailbox/index.js';
import { SendApi, InvalidSendError } from './send/index.js';
import { EnvelopeIdentity } from './identity/index.js';
import type { MissionGraph } from './identity/index.js';
import { TranscriptEffectConfirmer } from './confirm/index.js';
import type { EffectConfirmer } from './confirm/index.js';
import { createThreadRoute } from './threads/index.js';
import { MessageStore } from './store/index.js';
import { CHRIS_IDENTITY, CHRIS_MEMBER } from './types.js';
import type { MessageQuery, Room, SendMessage } from './types.js';

export { MessageStore } from './store/index.js';
export { RoomStore } from './rooms/index.js';
export {
  PtyDelivery,
  PtyDeliveryAdapter,
  MailboxDeliveryAdapter,
  HumanDeliveryAdapter,
} from './delivery/index.js';
export type { MessageDeliveryAdapter } from './delivery/index.js';
export { resolveActor } from './actors/index.js';
export type { ResolvedActor } from './actors/index.js';
export { MessageRouter, InterruptRateLimiter } from './router/index.js';
export { MailboxConflictError, MailboxRegistry } from './mailbox/index.js';
export { SendApi } from './send/index.js';
export { rosterFromAgents, nextSpawnName, isNameTaken } from './address/index.js';
export * from './types.js';

/** The TerminalManager surface messaging consumes. */
export interface AgentTerminals extends PtyWriter {
  list(): AgentInfo[];
}

export interface MessagingOptions {
  storePath?: string;
  roomsStorePath?: string;
  /** Durable mailbox registry file; defaults to .novakai-command/mailboxes.jsonl. */
  mailboxStorePath?: string;
  /** Inject a registry directly (tests/scratch rigs); wins over mailboxStorePath. */
  mailboxRegistry?: MailboxRegistry;
  timings?: DeliveryTimings;
  maxInterruptsPerMinute?: number;
  /** The durable mission graph — enables server-derived envelope identity
   * and the POST /api/threads mission↔room link. */
  missionGraph?: MissionGraph;
  /** D1 effect verification; defaults to the transcript confirmer. Tests
   * inject fakes; null disables confirmation entirely. */
  effectConfirmer?: EffectConfirmer | null;
  /** Bounded transcript-confirmation window per interrupt. */
  confirmTimeoutMs?: number;
  /** Restart reconciliation (D2) runs shortly after boot unless disabled. */
  reconcileOnStart?: boolean;
}

export class MessagingHub {
  private readonly store: MessageStore;
  private readonly delivery: PtyDelivery;
  private readonly rooms: RoomStore;
  private readonly mailboxes: MailboxRegistry;
  private readonly sendApi: SendApi;
  private readonly router: MessageRouter;
  private readonly missionGraph?: MissionGraph;

  constructor(
    private readonly terminals: AgentTerminals,
    private readonly broadcast: (event: string, payload: unknown) => void,
    options: MessagingOptions = {},
  ) {
    this.missionGraph = options.missionGraph;
    this.store = new MessageStore(options.storePath); this.rooms = new RoomStore(options.roomsStorePath);
    this.mailboxes = options.mailboxRegistry ?? new MailboxRegistry(options.mailboxStorePath);
    this.store.onAppend((envelope) => this.broadcast('message-envelope', envelope));
    this.rooms.onAppend(() => this.broadcast('rooms-changed', { rooms: this.rooms.list() }));
    this.delivery = new PtyDelivery(this.terminals, options.timings);
    this.router = this.buildRouter(options);
    this.sendApi = new SendApi(this.router);
    if (options.reconcileOnStart !== false) {
      // Delayed + unref'd: short-lived rigs exit before it fires; a real
      // backend reconciles the journal once the roster has had time to attach.
      const timer = setTimeout(() => { void this.router.reconcile(); }, 1500);
      timer.unref?.();
    }
  }

  private buildRouter(options: MessagingOptions): MessageRouter {
    const confirmer = options.effectConfirmer === null
      ? undefined
      : options.effectConfirmer ?? new TranscriptEffectConfirmer();
    return new MessageRouter(
      this.store,
      this.delivery,
      this.rooms,
      () => rosterFromAgents(this.terminals.list()),
      new InterruptRateLimiter(options.maxInterruptsPerMinute),
      (name) => this.mailboxes.identityFor(name),
      this.missionGraph ? new EnvelopeIdentity(this.missionGraph) : undefined,
      confirmer,
      (agentId) => this.presenceFor(agentId),
      options.confirmTimeoutMs,
    );
  }

  /** The Presence facts confirmation needs — live info from the terminal roster. */
  private presenceFor(agentId: string): { sessionId: string; projectDir?: string; provider: string } | null {
    const info = this.terminals.list().find((agent) => agent.agentId === agentId);
    if (!info?.sessionId) return null;
    return { sessionId: info.sessionId, projectDir: info.projectDir, provider: info.provider };
  }

  /** The durable mailbox registry — shared with AgentsHub for name checks. */
  get mailboxRegistry(): MailboxRegistry {
    return this.mailboxes;
  }

  /** The send seam — composition services (external-session registration)
   * announce through the same router as everyone else. */
  get send(): SendApi {
    return this.sendApi;
  }

  registerRoutes(application: Express): void {
    application.post('/api/user/messages', (request, response) => void this.handleUserSend(request, response));
    application.get('/api/messages', (request, response) => this.handleHistory(request, response));
    application.get('/api/identity', (_request, response) => response.json({ identity: CHRIS_IDENTITY }));
    application.get('/api/messaging/address-book', (_request, response) => response.json({
      mailboxes: this.mailboxes.list(),
      presences: rosterFromAgents(this.terminals.list()),
    }));
    application.post('/api/mailboxes', (request, response) => this.handleRegisterMailbox(request, response));
    application.post('/api/rooms', (request, response) => this.handleCreateRoom(request, response));
    application.post('/api/user/rooms', (request, response) => this.handleCreateUserRoom(request, response));
    application.get('/api/rooms', (_request, response) => response.json({ rooms: this.rooms.list() }));
    application.post(
      '/api/rooms/:roomId/members',
      (request, response) => this.handleAddMembers(request, response),
    );
    application.post('/api/threads', (request, response) => this.handleCreateThread(request, response));
  }

  /** The mission↔room link: one typed thread block in the system of record. */
  private handleCreateThread(request: Request, response: Response): void {
    createThreadRoute(request, response, this.missionGraph, (roomId) => this.rooms.get(roomId));
  }

  private handleRegisterMailbox(request: Request, response: Response): void {
    const payload = (request.body ?? {}) as { displayName?: unknown; memberName?: unknown };
    try {
      const displayName = this.requireText(payload.displayName, 'displayName');
      const memberName = this.requireText(payload.memberName, 'memberName');
      response.status(201).json({ identity: this.mailboxes.register({ displayName, memberName }) });
    } catch (error) {
      if (error instanceof MailboxConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleCreateRoom(request: Request, response: Response): void {
    const payload = (request.body ?? {}) as { name?: unknown; members?: unknown; from?: unknown };
    try {
      const name = this.requireText(payload.name, 'name');
      const members = this.requireStringArray(payload.members, 'members');
      const createdBy = this.requireText(payload.from, 'from');
      const resolvedMembers = createdBy === CHRIS_MEMBER
        ? [...new Set([...members, CHRIS_IDENTITY.memberName])]
        : members;
      response.status(201).json({ room: this.rooms.create({ name, members: resolvedMembers, createdBy }) });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleCreateUserRoom(request: Request, response: Response): void {
    const payload = (request.body ?? {}) as { name?: unknown; members?: unknown };
    try {
      const name = this.requireText(payload.name, 'name');
      const members = this.requireStringArray(payload.members, 'members');
      response.status(201).json({
        room: this.rooms.create({
          name,
          members: [...new Set([...members, CHRIS_IDENTITY.memberName])],
          createdBy: CHRIS_IDENTITY.memberName,
        }),
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private handleAddMembers(request: Request, response: Response): void {
    const roomId = request.params.roomId;
    const room = this.rooms.get(roomId);
    if (!room) {
      response.status(404).json({ error: new RoomNotFoundError(roomId).message });
      return;
    }
    const payload = (request.body ?? {}) as { 'add'?: unknown; from?: unknown };
    try {
      const sender = this.requireText(payload.from, 'from');
      if (!room.members.includes(sender)) {
        response.status(403).json({ error: new NotARoomMemberError(sender, roomId).message });
        return;
      }
      const membersToAdd = this.requireStringArray(payload.add, 'add');
      response.json({ room: this.rooms.addMembers(roomId, membersToAdd) as Room });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  private requireText(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`${field} must be a non-empty string`);
    }
    return value;
  }

  private requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
      throw new Error(`${field} must be an array of non-empty strings`);
    }
    return value;
  }

  private async handleUserSend(request: Request, response: Response): Promise<void> {
    const payload = (request.body ?? {}) as Partial<SendMessage> & { threadId?: string };
    await this.sendPayload(CHRIS_IDENTITY.memberName, payload, response);
  }

  private async sendPayload(
    sender: string,
    payload: Partial<SendMessage> & { threadId?: string },
    response: Response,
  ): Promise<void> {
    try {
      const envelope = await this.sendApi.send(sender, {
        'to': payload.to as string,
        delivery: payload.delivery as SendMessage['delivery'],
        body: payload.body as string,
        threadId: payload.threadId,
      });
      response.status(201).json({ envelope });
    } catch (error) {
      this.sendFailure(response, error);
    }
  }

  private sendFailure(response: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof InvalidSendError || error instanceof ChannelInterruptError) {
      response.status(400).json({ error: message });
    } else if (error instanceof RecipientNotFoundError) {
      response.status(404).json({ error: message, roster: error.roster, mailboxes: this.mailboxes.list() });
    } else if (error instanceof RoomNotFoundError) {
      response.status(404).json({ error: message });
    } else if (error instanceof NotARoomMemberError) {
      response.status(403).json({ error: message });
    } else if (error instanceof InterruptRateLimitError) {
      response.status(429).json({ error: message });
    } else if (error instanceof DeliveryFailedError) {
      response.status(502).json({ error: message });
    } else {
      response.status(500).json({ error: message });
    }
  }

  private handleHistory(request: Request, response: Response): void {
    const query: MessageQuery = {};
    if (typeof request.query.withAgent === 'string') query.withAgent = request.query.withAgent;
    if (typeof request.query.withRoom === 'string') query.withRoom = request.query.withRoom;
    if (typeof request.query.threadId === 'string') query.threadId = request.query.threadId;
    if (typeof request.query.missionId === 'string') query.missionId = request.query.missionId;
    if (typeof request.query.since === 'string') query.since = request.query.since;
    if (typeof request.query.limit === 'string') {
      const limit = Number.parseInt(request.query.limit, 10);
      if (Number.isFinite(limit) && limit > 0) query.limit = limit;
    }
    response.json({ messages: this.store.history(query) });
  }
}

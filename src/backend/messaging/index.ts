// Agent messaging tunnel wiring (docs/agent-messaging.md). Owns the surviving
// REST surface (GET /api/messages history, /api/user/messages, mailboxes,
// the free-room archive shim), and pushes every appended envelope over the
// existing WebSocket broadcast for the future Messages view (R6). Kept out
// of server/index.ts the same way AgentsHub is.
//
// N2 deletions: POST /api/messages + handleSend, and the spawn briefing.
// N3 deletions: routeChannel/routeRoom/deliverRoomMembers, the RoomStore
// class, POST /api/rooms + /api/rooms/:id/members. #team now lives in the
// messaging capability (fleet room): handleUserSend and the #team history
// read translate through the injected TeamLane (D-N3-3/4). Free rooms are
// archive-only via ./rooms (read fold + create writer, dies in N4).
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
import { DEFAULT_ROOMS_PATH, createRoom, getRoom, listRooms } from './rooms/index.js';
import { MailboxConflictError, MailboxRegistry } from './mailbox/index.js';
import { SendApi, InvalidSendError } from './send/index.js';
import { EnvelopeIdentity } from './identity/index.js';
import type { MissionGraph } from './identity/index.js';
import { TranscriptEffectConfirmer } from './confirm/index.js';
import type { EffectConfirmer } from './confirm/index.js';
import { createThreadRoute } from './threads/index.js';
import { MessageStore } from './store/index.js';
import { CHRIS_IDENTITY, TEAM_CHANNEL } from './types.js';
import type { MessageQuery, SendMessage } from './types.js';

export { MessageStore } from './store/index.js';
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

/**
 * D-N3-3/4: the capability-backed #team lane (implemented by the messagingV2
 * rooms glue; dies in N4). `from` is always the server-stamped human.
 */
export interface TeamLaneEnvelope {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAt: string;
  status: string;
  delivery: string;
}

export interface TeamLane {
  /** Human #team post; resolves to the translated old-shape envelope. */
  post(body: string): Promise<TeamLaneEnvelope>;
  /** Translated #team history (old shape; archive never merged, D1). */
  history(): Promise<TeamLaneEnvelope[]>;
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
  /** D-N3-3/4: lazy capability-backed #team lane (boots after this hub). */
  teamLane?: () => TeamLane | null;
}

export class MessagingHub {
  private readonly store: MessageStore;
  private readonly delivery: PtyDelivery;
  private readonly roomsPath: string;
  private readonly mailboxes: MailboxRegistry;
  private readonly sendApi: SendApi;
  private readonly router: MessageRouter;
  private readonly missionGraph?: MissionGraph;
  private readonly teamLane?: () => TeamLane | null;

  constructor(
    private readonly terminals: AgentTerminals,
    private readonly broadcast: (event: string, payload: unknown) => void,
    options: MessagingOptions = {},
  ) {
    this.missionGraph = options.missionGraph;
    this.teamLane = options.teamLane;
    this.store = new MessageStore(options.storePath);
    this.roomsPath = options.roomsStorePath ?? DEFAULT_ROOMS_PATH;
    this.mailboxes = options.mailboxRegistry ?? new MailboxRegistry(options.mailboxStorePath);
    this.store.onAppend((envelope) => this.broadcast('message-envelope', envelope));
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
    application.get('/api/messages', (request, response) => void this.handleHistory(request, response));
    application.get('/api/identity', (_request, response) => response.json({ identity: CHRIS_IDENTITY }));
    application.get('/api/messaging/address-book', (_request, response) => response.json({
      mailboxes: this.mailboxes.list(),
      presences: rosterFromAgents(this.terminals.list()),
    }));
    application.post('/api/mailboxes', (request, response) => this.handleRegisterMailbox(request, response));
    // Free-room archive shim (N3, dies in N4): reads + browser creation only.
    application.get('/api/rooms', (_request, response) => response.json({ rooms: listRooms(this.roomsPath) }));
    application.post('/api/user/rooms', (request, response) => this.handleCreateUserRoom(request, response));
    application.post('/api/threads', (request, response) => this.handleCreateThread(request, response));
  }

  /** The mission↔room link: one typed thread block in the system of record. */
  private handleCreateThread(request: Request, response: Response): void {
    createThreadRoute(request, response, this.missionGraph, (roomId) => getRoom(this.roomsPath, roomId));
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

  private handleCreateUserRoom(request: Request, response: Response): void {
    const payload = (request.body ?? {}) as { name?: unknown; members?: unknown };
    try {
      const name = this.requireText(payload.name, 'name');
      const members = this.requireStringArray(payload.members, 'members');
      const room = createRoom(this.roomsPath, {
        name,
        members: [...new Set([...members, CHRIS_IDENTITY.memberName])],
        createdBy: CHRIS_IDENTITY.memberName,
      });
      this.broadcast('rooms-changed', { rooms: listRooms(this.roomsPath) });
      response.status(201).json({ room });
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
    // D-N3-3: Chris's #team posts go through the capability (fleet room) —
    // capability delivery does the PTY fan-out; routeChannel is deleted.
    if (payload.to === TEAM_CHANNEL) {
      await this.sendTeamChannel(payload, response);
      return;
    }
    await this.sendPayload(CHRIS_IDENTITY.memberName, payload, response);
  }

  /** The #team user-send through the injected capability lane (D-N3-3). */
  private async sendTeamChannel(
    payload: Partial<SendMessage>,
    response: Response,
  ): Promise<void> {
    if (payload.delivery === 'interrupt') {
      response.status(400).json({ error: new ChannelInterruptError(TEAM_CHANNEL).message });
      return;
    }
    // FIX 7a: a missing/empty body is the CLIENT's error (400), never a 502.
    if (typeof payload.body !== 'string' || payload.body.trim() === '') {
      response.status(400).json({ error: 'body must be a non-empty string' });
      return;
    }
    const lane = this.teamLane?.() ?? null;
    if (lane === null) {
      response.status(503).json({ error: 'messaging capability unavailable this run — #team post not sent' });
      return;
    }
    await this.postTeamChannel(lane, payload.body, response);
  }

  /** Lane post + error mapping (FIX 7a: DependencyUnavailable → 503). */
  private async postTeamChannel(lane: TeamLane, body: string, response: Response): Promise<void> {
    try {
      response.status(201).json({ envelope: await lane.post(body) });
    } catch (error) {
      const unavailable = error instanceof Error && error.name === 'DependencyUnavailable';
      response.status(unavailable ? 503 : 502).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

  private async handleHistory(request: Request, response: Response): Promise<void> {
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
    // D-N3-4 READ shim: #team history translates from the capability (fleet
    // room, old envelope shape). The old journal's #team lines are archive —
    // NEVER merged (D1). Everything else keeps reading the old store.
    if (query.withAgent === TEAM_CHANNEL) {
      await this.teamHistory(response);
      return;
    }
    response.json({ messages: this.store.history(query) });
  }

  /** The translated #team read through the injected capability lane (D-N3-4). */
  private async teamHistory(response: Response): Promise<void> {
    const lane = this.teamLane?.() ?? null;
    if (lane === null) {
      response.status(503).json({ error: 'messaging capability unavailable this run — #team history unavailable' });
      return;
    }
    try {
      response.json({ messages: await lane.history() });
    } catch (error) {
      response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}

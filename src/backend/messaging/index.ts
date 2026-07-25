// Agent messaging tunnel wiring (docs/agent-messaging.md) — the SURVIVING
// sliver after N4. Everything message-shaped now lives in the messaging
// capability (messagingV2): agent lanes (N2), rooms (N3), and the browser
// feed/sends (N4). What remains here, by dependency:
//   - MailboxRegistry: durable mailbox identities for ExternalSessionsHub
//     and spawn-name checks (AgentsHub).
//   - POST /api/mailboxes: the registry route scripts use.
//   - POST /api/threads: the mission↔room link (stores-gated; room existence
//     now reads the archived rooms.jsonl fold — free rooms are archive-only).
// Deleted in N4: GET /api/messages, POST /api/user/messages, GET/POST
// /api/rooms*, GET /api/identity, the old address-book, SendApi,
// MessageRouter, PtyDelivery, the transcript confirmer, EnvelopeIdentity,
// actors/send/delivery/confirm/router/store dirs, the message-envelope and
// rooms-changed broadcasts, and the N3 browser shims.
import type { Express, Request, Response } from 'express';
import { getRoom } from './rooms/index.js';
import { MailboxConflictError, MailboxRegistry } from './mailbox/index.js';
import type { MissionGraph } from './threads/index.js';
import { createThreadRoute } from './threads/index.js';

export { MailboxConflictError, MailboxRegistry } from './mailbox/index.js';
export { rosterFromAgents, nextSpawnName, isNameTaken } from './address/index.js';
export * from './types.js';

export interface MessagingOptions {
  /** Durable mailbox registry file; defaults to .novakai-command/mailboxes.jsonl. */
  mailboxStorePath?: string;
  /** Inject a registry directly (tests/scratch rigs); wins over mailboxStorePath. */
  mailboxRegistry?: MailboxRegistry;
  /** The durable mission graph — enables the POST /api/threads mission↔room link. */
  missionGraph?: MissionGraph;
  /** Archived free-room file for the /api/threads existence check. */
  roomsStorePath?: string;
}

export class MessagingHub {
  private readonly mailboxes: MailboxRegistry;
  private readonly missionGraph?: MissionGraph;
  private readonly roomsPath?: string;

  constructor(options: MessagingOptions = {}) {
    this.mailboxes = options.mailboxRegistry ?? new MailboxRegistry(options.mailboxStorePath);
    this.missionGraph = options.missionGraph;
    this.roomsPath = options.roomsStorePath;
  }

  /** The durable mailbox registry — shared with AgentsHub for name checks. */
  get mailboxRegistry(): MailboxRegistry {
    return this.mailboxes;
  }

  registerRoutes(application: Express): void {
    application.post('/api/mailboxes', (request, response) => this.handleRegisterMailbox(request, response));
    application.post('/api/threads', (request, response) => this.handleCreateThread(request, response));
  }

  /** The mission↔room link: one typed thread block in the system of record. */
  private handleCreateThread(request: Request, response: Response): void {
    createThreadRoute(request, response, this.missionGraph, (roomId) => getRoom(this.roomsPath, roomId));
  }

  private handleRegisterMailbox(request: Request, response: Response): void {
    const payload = (request.body ?? {}) as { displayName?: unknown; memberName?: unknown };
    try {
      const displayName = requireText(payload.displayName, 'displayName');
      const memberName = requireText(payload.memberName, 'memberName');
      response.status(201).json({ identity: this.mailboxes.register({ displayName, memberName }) });
    } catch (error) {
      if (error instanceof MailboxConflictError) {
        response.status(409).json({ error: error.message });
        return;
      }
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

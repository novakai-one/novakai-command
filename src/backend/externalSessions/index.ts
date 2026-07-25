// External session registration (mission_external-session-visibility): a
// session spawned OUTSIDE the backend (a terminal-spawned chief or agent) is
// registered into the durable mission graph — Agent record, Presence attach,
// mailbox — so Mission Control's envelope-derived DM lane is backed by
// durable identity. The hub composes three proven seams and owns no transport
// knowledge: delivery to an external session is the mailbox pull pattern
// (journal + ws), never PTY control — the contract's fallback is discharged
// by construction. Dependencies are narrow structural interfaces injected at
// composition (dependency inversion, same pattern as MissionGraph).
import type { Express, Request, Response } from 'express';
import { PROVIDER_IDS } from '../../shared/project/schema.js';
import { isChannel, isRoom } from '../messaging/types.js';
import type { MailboxIdentity } from '../messaging/types.js';

/** The slice of the durable mission graph registration needs. */
export interface ExternalSessionGraph {
  missionRecord(missionId: string): Record<string, unknown> | null;
  createTeam(input: { name: string; missionId: string }): string;
  createAgent(input: { name: string; provider: string; teamId: string; missionId: string }): string;
  attachAgentSession(agentId: string, sessionId: string): 'attached' | 'noop' | 'unknown';
  markAgentFailed(agentId: string, reason: string): void;
  /** The durable Agent already registered for this session, or null — the
   * idempotency lookup (Ruling 1b): an already-registered session is never
   * minted twice. */
  agentForSession(sessionId: string): { agentId: string; teamId: string | null } | null;
}

/** The slice of the durable mailbox registry registration needs. */
export interface ExternalSessionMailboxes {
  identityFor(memberName: string): MailboxIdentity | undefined;
  register(input: { displayName: string; memberName: string }): MailboxIdentity;
}

/** The send seam: authenticate as the durable agentId, send to the human
 * principal through the capability (N4 — the old SendApi path is deleted).
 * Resolves to the accepted messageId. */
export type SendExternal = (agentId: string, body: string) => Promise<{ id: string }>;

/** The name collides with a live backend-owned PTY — reuse is never safe there. */
export class ExternalSessionNameConflictError extends Error {}

/** A domain request the hub rejects — maps to a 400 at the API edge. */
export class ExternalSessionValidationError extends Error {}

export interface RegisterExternalInput {
  name: string;
  provider: string;
  sessionId: string;
  missionId: string;
  teamId?: string;
  /** Default true: one envelope name→chris materializes/updates the DM lane. */
  announce?: boolean;
}

export interface RegisterExternalResult {
  agentId: string;
  teamId: string;
  /** 'existing' when the name already held a durable mailbox (reuse is the mission). */
  mailbox: 'created' | 'existing';
  announcement: 'sent' | 'skipped' | 'failed';
  envelopeId?: string;
  announcementError?: string;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExternalSessionValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

interface ValidatedRegistration {
  name: string;
  provider: string;
  sessionId: string;
  missionId: string;
  mailboxExists: boolean;
}

/** The lane-materializing message: one announcement agent→chris DM. */
function announcementBody(
  input: RegisterExternalInput,
  persisted: { agentId: string; mailbox: 'created' | 'existing' },
): string {
  return `📡 ${input.name} registered as durable agent ${persisted.agentId} `
    + `(external ${input.provider} session ${input.sessionId}, mission ${input.missionId}, mailbox ${persisted.mailbox}). `
    + 'This DM lane is live — messages here reach my mailbox.';
}

export class ExternalSessionsHub {
  constructor(
    private readonly graph: ExternalSessionGraph,
    private readonly mailboxes: ExternalSessionMailboxes,
    private readonly sendExternal: SendExternal,
    /** Live backend-owned PTY titles — the ONLY collision that rejects. */
    private readonly liveNames: () => string[],
  ) {}

  /**
   * Register one externally-spawned session. Validation runs BEFORE the first
   * store write, so the validated path can never leave an orphan team behind
   * (the residual window — team appended, then createAgent fails despite a
   * validated mission — is named in plan §3; a failed agent is always marked
   * explicitly, never silent).
   */
  async register(input: RegisterExternalInput): Promise<RegisterExternalResult> {
    const validated = this.validate(input);
    const persisted = this.persist(validated, input.teamId);
    return this.announce(input, persisted);
  }

  /** Every rejection happens here, before any store write (audit MODERATE-1/3). */
  private validate(input: RegisterExternalInput): ValidatedRegistration {
    const name = requireText(input.name, 'name');
    const provider = requireText(input.provider, 'provider');
    const sessionId = requireText(input.sessionId, 'sessionId');
    const missionId = requireText(input.missionId, 'missionId');
    if (isChannel(name) || isRoom(name)) {
      throw new ExternalSessionValidationError(`name "${name}" collides with channel/room addressing`);
    }
    if (!PROVIDER_IDS.includes(provider as (typeof PROVIDER_IDS)[number])) {
      throw new ExternalSessionValidationError(`provider must be one of ${PROVIDER_IDS.join(', ')}`);
    }
    // Split name check: a live-PTY collision rejects; an existing durable
    // mailbox is ALLOWED and reported — reuse is the mission.
    if (this.liveNames().includes(name)) {
      throw new ExternalSessionNameConflictError(`name "${name}" belongs to a live agent terminal`);
    }
    if (this.graph.missionRecord(missionId) === null) {
      throw new ExternalSessionValidationError(`mission "${missionId}" resolves to no record`);
    }
    return { name, provider, sessionId, missionId, mailboxExists: this.mailboxes.identityFor(name) !== undefined };
  }

  /** The durable writes: team → agent → Presence attach → mailbox. Idempotent
   * per session (Ruling 1b): an already-registered session reuses its durable
   * Agent — a redeploy/re-run never mints a second registration. */
  private persist(
    validated: ValidatedRegistration,
    teamIdInput: string | undefined,
  ): { agentId: string; teamId: string; mailbox: 'created' | 'existing' } {
    const existing = this.graph.agentForSession(validated.sessionId);
    if (existing) return this.reattach(validated, existing, teamIdInput);
    let agentId: string | null = null;
    try {
      const teamId = teamIdInput ?? this.graph.createTeam({ name: `${validated.name} (external)`, missionId: validated.missionId });
      agentId = this.graph.createAgent({ name: validated.name, provider: validated.provider, teamId, missionId: validated.missionId });
      this.graph.attachAgentSession(agentId, validated.sessionId);
      if (!validated.mailboxExists) this.mailboxes.register({ displayName: validated.name, memberName: validated.name });
      return { agentId, teamId, mailbox: validated.mailboxExists ? 'existing' : 'created' };
    } catch (error) {
      if (agentId !== null) this.markFailedQuietly(agentId, error);
      throw error;
    }
  }

  /** The idempotent path: re-attach the session to its existing durable Agent. */
  private reattach(
    validated: ValidatedRegistration,
    existing: { agentId: string; teamId: string | null },
    teamIdInput: string | undefined,
  ): { agentId: string; teamId: string; mailbox: 'created' | 'existing' } {
    this.graph.attachAgentSession(existing.agentId, validated.sessionId);
    if (!validated.mailboxExists) this.mailboxes.register({ displayName: validated.name, memberName: validated.name });
    return {
      agentId: existing.agentId,
      teamId: teamIdInput ?? existing.teamId ?? '',
      mailbox: validated.mailboxExists ? 'existing' : 'created',
    };
  }

  /** The announcement materializes the DM lane (envelope-derived lanes), but
   * the registration stands on its own — a failed envelope is reported,
   * never fatal. */
  private async announce(
    input: RegisterExternalInput,
    persisted: { agentId: string; teamId: string; mailbox: 'created' | 'existing' },
  ): Promise<RegisterExternalResult> {
    const result: RegisterExternalResult = { ...persisted, announcement: 'skipped' };
    if (input.announce === false) return result;
    try {
      const envelope = await this.sendExternal(persisted.agentId, announcementBody(input, persisted));
      result.announcement = 'sent';
      result.envelopeId = envelope.id;
    } catch (error) {
      result.announcement = 'failed';
      result.announcementError = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  /** A store hiccup while recording the failure must not mask the real error. */
  private markFailedQuietly(agentId: string, cause: unknown): void {
    try {
      this.graph.markAgentFailed(agentId, cause instanceof Error ? cause.message : String(cause));
    } catch {
      // the original error propagates — the failure record is best-effort here
    }
  }

  registerRoutes(application: Express): void {
    application.post('/api/external-sessions', (request, response) => void this.handleRegister(request, response));
  }

  private async handleRegister(request: Request, response: Response): Promise<void> {
    const payload = (request.body ?? {}) as Partial<RegisterExternalInput>;
    try {
      const result = await this.register({
        'name': payload.name as string,
        'provider': payload.provider as string,
        'sessionId': payload.sessionId as string,
        'missionId': payload.missionId as string,
        ...(typeof payload.teamId === 'string' ? { 'teamId': payload.teamId } : {}),
        ...(payload.announce === false ? { 'announce': false } : {}),
      });
      response.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ExternalSessionNameConflictError) response.status(409).json({ error: message });
      else if (error instanceof ExternalSessionValidationError) response.status(400).json({ error: message });
      else response.status(500).json({ error: message });
    }
  }
}

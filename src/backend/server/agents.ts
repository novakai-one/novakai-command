// Persistent-agent wiring: ws agent-* frames, watch-session (additive per
// socket, now also drives a SubagentWatcher), and the /api/agents REST
// surface. Kept out of server/index.ts to hold that file's diff to a few
// lines per docs/persistent-agents.md §3, §5, §6.
import type { Express, Request, Response } from 'express';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { PROVIDER_IDS } from '../../shared/project/schema.js';
import type { ProviderId } from '../../shared/project/schema.js';
import { TerminalManager, type AgentInfo, type CreateAgentOptions } from '../terminal/manager.js';
import type { TerminalRuntime } from '../terminal/runtime/index.js';
import { nextSpawnName, isNameTaken } from '../messaging/address/index.js';
import { mailboxIdentityFor } from '../messaging/types.js';
import type { MailboxLookup } from '../messaging/types.js';
import { ConfigManager } from '../config/index.js';
import { SessionWatcher, CLAUDE_DIR, listSessions } from '../transcript/parser.js';
import { SubagentWatcher } from '../transcript/subagents/index.js';
import type { SessionControlIntent } from '../../shared/sessionControl.js';
import { SessionControl } from '../terminal/control/index.js';
import { deriveHealth, thresholdsFromEnv, type AgentHealth, type HealthThresholds } from '../terminal/health/index.js';
import type { SeatWatch } from '../terminal/seatWatch/index.js';
import type { TokenStore } from '../messagingV2/tokens/index.js';
import { NudgeAction } from '../terminal/nudge/index.js';
import { ObjectModel } from '../objectModel/index.js';
import { resolveMissionSpawn } from './missionSpawn/index.js';

const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const SESSION_RE = /^[A-Za-z0-9-]+$/;

function isValidProject(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_RE.test(value) && value !== '.' && value !== '..';
}

function isValidSession(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value);
}

function resolveSessionPath(projectDir: string, sessionId: string): string | null {
  const sessions = listSessions(projectDir);
  const found = sessions.find((session) => session.sessionId === sessionId);
  const filePath = found ? found.filePath : path.join(CLAUDE_DIR, projectDir, `${sessionId}.jsonl`);
  const resolved = path.resolve(filePath);
  return resolved.startsWith(CLAUDE_DIR + path.sep) ? resolved : null;
}

interface SessionWatchPair {
  session: SessionWatcher;
  subagent: SubagentWatcher;
}

export class AgentsHub {
  private readonly agentSubs = new Map<WebSocket, Set<string>>();
  private readonly sessionWatchers = new Map<WebSocket, Map<string, SessionWatchPair>>();
  private readonly sessionListeners: Array<(info: AgentInfo) => void> = [];
  private readonly launchListeners: Array<(info: AgentInfo) => void> = [];
  private readonly sessionControl: SessionControl;
  private readonly nudge: NudgeAction;
  /** Ruled stall thresholds, read once at composition (env overrides are rig-only). */
  private readonly thresholds: HealthThresholds = thresholdsFromEnv();
  /** D-N5-6: attached by the composition root after the seat-watch boots. */
  private seatWatch: SeatWatch | null = null;

  constructor(
    private readonly sockets: Set<WebSocket>,
    private readonly manager: TerminalRuntime = new TerminalManager(),
    /** Durable mailbox names are always taken; defaults to the static seeds. */
    private readonly mailboxLookup: MailboxLookup = mailboxIdentityFor,
    /** The durable mission graph — absent in setups without stores (tests). */
    private readonly objectModel?: ObjectModel,
    /** Injectable nudge record path (tests); defaults inside NudgeAction. */
    nudgeRecordPath?: string,
    /** D-N6-2: spawn credentials (env NVK_AGENT_TOKEN); absent in tests. */
    private readonly tokenStore?: TokenStore,
  ) {
    this.sessionControl = new SessionControl(this.manager);
    this.nudge = new NudgeAction(this.manager, nudgeRecordPath);
    this.manager.onData((agentId, data) => {
      this.sendToSubscribers(agentId, { type: 'agent-data', agentId, data });
    });
    this.manager.onExit((agentId, exitCode) => this.handleExit(agentId, exitCode));
    this.manager.onSession((info) => {
      // Presence resolved → attach to the durable Agent (idempotent; 'unknown'
      // just means this spawn is outside the mission model). The record always
      // exists before the PTY (ruling S4), so this can never race creation.
      if (info.sessionId) this.attachSessionSafely(info.agentId, info.sessionId);
      this.broadcastAgentsChanged();
      for (const listener of this.sessionListeners) listener(info);
    });
  }

  /** A store hiccup must not take down session plumbing — log and continue. */
  private attachSessionSafely(agentId: string, sessionId: string): void {
    try {
      this.objectModel?.attachAgentSession(agentId, sessionId);
    } catch (error) {
      console.error(`[agents] session attach failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  onSessionResolved(listener: (info: AgentInfo) => void): void {
    this.sessionListeners.push(listener);
  }

  /** Fires after every successful launch — the messaging tunnel briefs new agents here. */
  onLaunch(listener: (info: AgentInfo) => void): void {
    this.launchListeners.push(listener);
  }

  /** The terminal surface the messaging tunnel routes through (roster + PTY writes). */
  get terminals(): TerminalRuntime {
    return this.manager;
  }

  /** D-N5-6: the health route annotates from the live seat-watch afterwards. */
  attachSeatWatch(watch: SeatWatch): void {
    this.seatWatch = watch;
  }

  handleMessage(socket: WebSocket, message: Record<string, unknown>): boolean {
    if (message.type === 'agent-subscribe') return this.subscribe(socket, message);
    if (message.type === 'agent-input') return this.input(message);
    if (message.type === 'agent-resize') return this.resize(message);
    if (message.type === 'agent-control') return this.control(socket, message);
    if (message.type === 'watch-session') return this.watchSession(socket, message);
    if (message.type === 'unwatch-session') return this.unwatchSession(socket, message);
    return false;
  }

  handleClose(socket: WebSocket): void {
    this.agentSubs.delete(socket);
    this.stopAllForSocket(socket);
    this.sessionWatchers.delete(socket);
  }

  registerRoutes(application: Express): void {
    application.post('/api/agents', (request, response) => this.createAgent(request, response));
    application.get('/api/agents', (_request, response) => response.json({ agents: this.listWithHealth() }));
    // D-N7-7: registered BEFORE the parameterized route ('slack-bridge' must
    // never resolve as an agentId).
    application.get('/api/agents/slack-bridge/health', (_request, response) => this.slackBridgeHealth(response));
    application.get('/api/agents/:agentId/health', (request, response) => this.agentHealth(request, response));
    application.post('/api/agents/:agentId/nudge', (request, response) => this.nudgeAgent(request, response));
    application.get('/api/agents/:agentId/identity', (request, response) => this.agentIdentity(request, response));
    application.patch('/api/agents/:agentId', (request, response) => this.renameAgent(request, response));
    application.post('/api/agents/:agentId/kill', (request, response) => this.killAgent(request, response));
    application.delete('/api/agents/:agentId', (request, response) => this.archiveAgent(request, response));
  }

  /** Launch one persistent provider terminal and announce it to every client. */
  async launch(options: CreateAgentOptions) {
    const info = await this.manager.create(options);
    this.broadcastAgentsChanged();
    for (const listener of this.launchListeners) listener(info);
    return info;
  }

  /** Health is derived at read time — never stored, never broadcast stale.
   * The agents-changed ws frames stay plain AgentInfo on purpose: a pushed
   * health snapshot silently ages; consumers poll the REST surface instead. */
  private healthFor(info: AgentInfo): AgentHealth | null {
    return deriveHealth(info.status, this.manager.activity(info.agentId), Date.now(), this.thresholds);
  }

  private listWithHealth(): Array<AgentInfo & { health: AgentHealth | null }> {
    return this.manager.list().map((info) => ({ ...info, health: this.healthFor(info) }));
  }

  /** D-N7-7: the Slack bridge's health block + cursor, read from its state
   * file (the bridge is the only writer). 404 when the file is absent (the
   * bridge never ran); 503 when stale — updatedAt older than 5 minutes
   * means the bridge is down or wedged. */
  private slackBridgeHealth(response: Response): void {
    const statePath = process.env.NVK_SLACK_BRIDGE_STATE
      ?? path.resolve('.novakai-command', 'slack-bridge-state.json');
    let parsed: { cursor?: unknown; health?: { updatedAt?: string } };
    try {
      parsed = JSON.parse(readFileSync(statePath, 'utf8')) as typeof parsed;
    } catch {
      response.status(404).json({ error: 'slack-bridge state file not found' });
      return;
    }
    const updatedAt = typeof parsed.health?.updatedAt === 'string' ? parsed.health.updatedAt : null;
    // F8: a non-ISO updatedAt is stale/503 honestly — never 200-garbage.
    const parsedAt = updatedAt === null ? Number.NaN : Date.parse(updatedAt);
    const staleMs = Number.isFinite(parsedAt) ? Date.now() - parsedAt : Number.POSITIVE_INFINITY;
    if (staleMs > 5 * 60_000) {
      response.status(503).json({ error: 'slack-bridge health is stale (bridge down or wedged)', updatedAt });
      return;
    }
    response.json({ cursor: parsed.cursor ?? 0, health: parsed.health });
  }

  private agentHealth(request: Request, response: Response): void {
    const info = this.manager.list().find((agent) => agent.agentId === request.params.agentId);
    if (!info) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    response.json({
      agentId: info.agentId, status: info.status,
      health: this.healthFor(info), seatWatch: this.seatWatch?.stateFor(info.agentId) ?? null,
    });
  }

  private nudgeAgent(request: Request, response: Response): void {
    const agentId = request.params.agentId;
    const info = this.manager.list().find((agent) => agent.agentId === agentId);
    if (!info) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    const healthBefore = this.healthFor(info);
    const result = this.nudge.execute(agentId, healthBefore);
    if (result.status === 'rejected') {
      response.status(409).json({ error: result.reason });
      return;
    }
    response.status(202).json({ agentId, nudgeId: result.nudgeId, healthBefore });
  }

  private handleExit(agentId: string, exitCode: number | null): void {
    this.sendToSubscribers(agentId, { type: 'agent-exit', agentId, exitCode });
    this.broadcastAgentsChanged();
  }

  private sendToSubscribers(agentId: string, message: object): void {
    const payload = JSON.stringify(message);
    for (const [socket, agentIds] of this.agentSubs) {
      if (agentIds.has(agentId) && socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  private broadcastAgentsChanged(): void {
    const payload = JSON.stringify({ type: 'agents-changed', agents: this.manager.list() });
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  private subscribe(socket: WebSocket, message: Record<string, unknown>): boolean {
    if (typeof message.agentId !== 'string') return true;
    const agentIds = this.agentSubs.get(socket) ?? new Set<string>();
    agentIds.add(message.agentId);
    this.agentSubs.set(socket, agentIds);
    const snapshot = this.manager.snapshot(message.agentId);
    socket.send(JSON.stringify({ type: 'agent-replay', agentId: message.agentId, data: snapshot }));
    return true;
  }

  private input(message: Record<string, unknown>): boolean {
    if (typeof message.agentId !== 'string' || typeof message.data !== 'string') return true;
    this.manager.write(message.agentId, message.data);
    return true;
  }

  private resize(message: Record<string, unknown>): boolean {
    const valid = typeof message.agentId === 'string'
      && typeof message.cols === 'number' && typeof message.rows === 'number';
    if (!valid) return true;
    this.manager.resize(message.agentId as string, message.cols as number, message.rows as number);
    return true;
  }

  private control(socket: WebSocket, message: Record<string, unknown>): boolean {
    if (
      typeof message.commandId !== 'string'
      || typeof message.agentId !== 'string'
      || !isSessionControlIntent(message.intent)
    ) return true;
    const result = this.sessionControl.execute(message.agentId, message.intent);
    this.sendIfOpen(socket, {
      type: 'agent-control-result',
      commandId: message.commandId,
      ...result,
    });
    return true;
  }

  private watchSession(socket: WebSocket, message: Record<string, unknown>): boolean {
    const projectDir = message.projectDir ?? message.project;
    const sessionId = message.sessionId ?? message.session;
    // Dialect: new clients (agentSocket) send projectDir/sessionId and get the
    // spec §5 type-keyed frames (additive/deduped, multi-watch per socket); the
    // legacy tab sends project/session and re-sends watch-session on every
    // session switch, so it must stop+replace (single-watch-per-socket).
    const newDialect = message.projectDir !== undefined;
    if (!isValidProject(projectDir) || !isValidSession(sessionId)) return true;
    if (!newDialect) this.stopAllForSocket(socket);
    else if (this.watchersFor(socket).has(sessionId)) return true;
    this.startWatchers(socket, projectDir, sessionId, newDialect);
    return true;
  }

  private unwatchSession(socket: WebSocket, message: Record<string, unknown>): boolean {
    const { projectDir, sessionId } = message;
    if (!isValidProject(projectDir) || !isValidSession(sessionId)) return true;
    const watcherMap = this.sessionWatchers.get(socket);
    const pair = watcherMap?.get(sessionId);
    if (!watcherMap || !pair) return true;
    this.stopPair(pair);
    watcherMap.delete(sessionId);
    return true;
  }

  private stopAllForSocket(socket: WebSocket): void {
    const watcherMap = this.sessionWatchers.get(socket);
    if (!watcherMap) return;
    for (const pair of watcherMap.values()) this.stopPair(pair);
    watcherMap.clear();
  }

  private watchersFor(socket: WebSocket): Map<string, SessionWatchPair> {
    let watcherMap = this.sessionWatchers.get(socket);
    if (!watcherMap) {
      watcherMap = new Map();
      this.sessionWatchers.set(socket, watcherMap);
    }
    return watcherMap;
  }

  private startWatchers(socket: WebSocket, projectDir: string, sessionId: string, newDialect: boolean): void {
    const resolved = resolveSessionPath(projectDir, sessionId);
    if (!resolved) return;
    const session = this.startSessionWatcher(socket, projectDir, sessionId, resolved, newDialect);
    const subagent = new SubagentWatcher(projectDir, sessionId, (event) => this.sendIfOpen(socket, event));
    subagent.start();
    this.watchersFor(socket).set(sessionId, { session, subagent });
  }

  private startSessionWatcher(
    socket: WebSocket, projectDir: string, sessionId: string, resolved: string, newDialect: boolean
  ): SessionWatcher {
    const watcher = new SessionWatcher(resolved);
    watcher.on('event', (event) => this.sendIfOpen(socket, newDialect
      ? { type: 'transcript-event', sessionId, event }
      : { event: 'transcript-event', payload: event }));
    watcher.start();
    this.sendIfOpen(socket, newDialect
      ? { type: 'watch-started', sessionId }
      : { event: 'watch-started', payload: { project: projectDir, session: sessionId } });
    return watcher;
  }

  private sendIfOpen(socket: WebSocket, message: object): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private stopPair(pair: SessionWatchPair): void {
    pair.session.stop();
    pair.subagent.stop();
  }

  private parseProvider(value: unknown): ProviderId | null {
    if (value === undefined) return 'claude';
    return PROVIDER_IDS.includes(value as ProviderId) ? (value as ProviderId) : null;
  }

  /** Messaging addressing (§5): a short unique name at spawn — provider +
   * ordinal when none is supplied, 409 (null) on collisions. */
  private resolveSpawnTitle(request: Request, response: Response, provider: ProviderId): string | null {
    const requested = typeof request.body?.title === 'string' ? request.body.title : undefined;
    if (requested !== undefined && isNameTaken(requested, this.manager.list(), undefined, this.mailboxLookup)) {
      response.status(409).json({ error: `agent name "${requested}" is already taken` });
      return null;
    }
    return requested ?? nextSpawnName(provider, this.manager.list().map((agent) => agent.title));
  }

  /** D-N6-2: the spawn's credential — ensured in the store, env-injected,
   * never printed (the agent's own PTY is the only reader). */
  private spawnTokenFor(agentId: string | null | undefined): string | undefined {
    if (agentId == null || this.tokenStore === undefined) return undefined;
    this.tokenStore.ensure(agentId);
    return this.tokenStore.tokenForAgent(agentId) ?? undefined;
  }

  /** The launch half of a spawn: env credential resolved, failure marked. */
  private async launchCreated(
    response: Response, title: string, cwd: string, provider: ProviderId, agentId: string | undefined | null,
  ): Promise<void> {
    const agentToken = this.spawnTokenFor(agentId ?? null);
    try {
      response.status(201).json(await this.launch({
        title, cwd, provider,
        ...(agentId ? { agentId } : {}),
        ...(agentToken !== undefined ? { agentToken } : {}),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (agentId) this.markFailedSafely(agentId, message);
      response.status(500).json({ error: message });
    }
  }

  private async createAgent(request: Request, response: Response): Promise<void> {
    const configuration = ConfigManager.load();
    const cwd = request.body?.cwd ?? configuration.activeRepo ?? process.cwd();
    const provider = this.parseProvider(request.body?.provider);
    if (!provider) {
      response.status(400).json({ error: `provider must be one of ${PROVIDER_IDS.join(', ')}` });
      return;
    }
    const title = this.resolveSpawnTitle(request, response, provider);
    if (title === null) return;
    // Mission spawn (plan v2 §1.4): one id minted once, durable Agent block
    // persisted BEFORE the Presence exists, launch failure marked explicitly.
    const agentId = resolveMissionSpawn(request, response, this.objectModel, title, provider);
    if (agentId === null) return;
    await this.launchCreated(response, title, cwd, provider, agentId);
  }

  private markFailedSafely(agentId: string, reason: string): void {
    try {
      this.objectModel?.markAgentFailed(agentId, reason);
    } catch (error) {
      console.error(`[agents] failed-state record for ${agentId} could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The confirmation projection (plan v2 §1.4): durable Agent + runtime
   * Presence in one response — everything scripts/team/confirm.mjs needs. */
  private agentIdentity(request: Request, response: Response): void {
    const agentId = request.params.agentId;
    const runtime = this.manager.list().find((agent) => agent.agentId === agentId) ?? null;
    const durable = this.objectModel?.agentRecord(agentId) ?? null;
    if (!runtime && !durable) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    response.json({ agentId, durable, runtime });
  }

  private renameAgent(request: Request, response: Response): void {
    const title = request.body?.title;
    if (typeof title !== 'string') {
      response.status(400).json({ error: 'title is required' });
      return;
    }
    if (isNameTaken(title, this.manager.list(), request.params.agentId, this.mailboxLookup)) {
      response.status(409).json({ error: `agent name "${title}" is already taken` });
      return;
    }
    if (!this.manager.rename(request.params.agentId, title)) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    this.broadcastAgentsChanged();
    response.status(204).end();
  }

  private killAgent(request: Request, response: Response): void {
    if (!this.manager.kill(request.params.agentId)) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    this.broadcastAgentsChanged();
    response.status(204).end();
  }

  private archiveAgent(request: Request, response: Response): void {
    if (!this.manager.archive(request.params.agentId)) {
      response.status(404).json({ error: 'Agent not found' });
      return;
    }
    this.broadcastAgentsChanged();
    response.status(204).end();
  }
}

function isSessionControlIntent(value: unknown): value is SessionControlIntent {
  if (!value || typeof value !== 'object') return false;
  const intent = value as Record<string, unknown>;
  if (intent.kind === 'interrupt') return true;
  return intent.kind === 'model' && typeof intent.model === 'string';
}

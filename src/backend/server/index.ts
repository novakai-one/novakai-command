import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { AgentCoordinator } from '../agent/index.js';
import { ConfigManager } from '../config/index.js';
import { StateManager } from '../state/index.js';
import { exec } from 'node:child_process';
import { listSessions, readSession, listSubagents, readSubagent, CLAUDE_DIR } from '../transcript/parser.js';
import { matchSessions } from '../transcript/repoIndex.js';
import { sessionUsage } from '../transcript/usage/index.js';
import { readRuleset } from '../ruleset/reader.js';
import { listDir, resolveGitRoot, clampToHome, PathDeniedError, NotFoundError } from '../fs/explorer.js';
import { getRepoInfo } from '../versionControl/index.js';
import { AgentsHub } from './agents.js';
import { ProjectsHub } from './projects/index.js';
import { CanvasHub } from './canvas/index.js';
import { AnalyticsHub } from './analytics/index.js';
import { DesignHub } from './design/index.js';
import { MailboxRegistry, MessagingHub, rosterFromAgents } from '../messaging/index.js';
import { MissionViewHub } from '../missionView/index.js';
import { ObjectModel } from '../objectModel/index.js';
import { startMessagingV2 } from '../messagingV2/index.js';
import type { MessagingV2Handle } from '../messagingV2/index.js';
import { HUMAN_PERSON_ID } from '../messagingV2/index.js';
import { registerMessagingV2Routes } from '../messagingV2/routes/index.js';
import { registerMessagingV2UserRoutes } from '../messagingV2/userRoutes/index.js';
import { defaultCapabilityJournalPath } from '../messagingV2/journal/index.js';
import { createMessagingLive } from '../messagingV2/live/index.js';
import type { MessagingLive } from '../messagingV2/live/index.js';
import { ExternalSessionsHub } from '../externalSessions/index.js';
import { PeopleHub } from '../people/index.js';
import type { TerminalRuntime } from '../terminal/runtime/index.js';
import { createSeatWatch, tickSafely } from '../terminal/seatWatch/index.js';
import { ensureWatchdogIdentity, WATCHDOG_AGENT_NAME } from './watchdogIdentity/index.js';
import { createTokenStore } from '../messagingV2/tokens/index.js';
import { createExternalsStore } from '../messagingV2/externals/index.js';
import type { MessagingSession } from '../../../packages/messaging/public/capability.js';

const PROJECT_RE = /^[A-Za-z0-9._-]+$/;
const SESSION_RE = /^[A-Za-z0-9-]+$/;
const AGENT_RE = /^agent-[A-Za-z0-9]+$/;

function isValidProjectDir(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_RE.test(value) && value !== '.' && value !== '..';
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_RE.test(value);
}

function validateProjectSession(
  request: express.Request,
  response: express.Response
): { projectDir: string; sessionId: string } | null {
  const projectDir = request.query.project as string;
  const sessionId = request.query.session as string;
  if (!isValidProjectDir(projectDir)) {
    response.status(400).json({ error: 'invalid project parameter' });
    return null;
  }
  if (!isValidSessionId(sessionId)) {
    response.status(400).json({ error: 'invalid session parameter' });
    return null;
  }
  return { projectDir, sessionId };
}

/**
 * Production ('npm run prod') serves the browser from a pinned deploy snapshot:
 * `staticDir` points at the snapshot's built frontend, `appPort` (3030) adds a
 * second listener so the app is same-origin — API, ws, and static assets all
 * come from one process. Dev leaves both unset; vite owns the dev lane's app
 * port (3130) and the Live pair 3030/3031 stays with the snapshot serve.
 */
export interface ServerOptions {
  staticDir?: string;
  appPort?: number;
}

export class ServerController {
  private readonly app = express();
  private readonly server: HttpServer;
  private readonly wsServer: WebSocketServer;
  private appServer?: HttpServer;
  private appWss?: WebSocketServer;
  private readonly activeSockets = new Set<WebSocket>();
  private readonly agentsHub: AgentsHub;
  private readonly projectsHub: ProjectsHub;
  private readonly canvasHub: CanvasHub;
  private readonly analyticsHub: AnalyticsHub;
  private readonly designHub: DesignHub;
  private readonly messagingHub: MessagingHub;
  private readonly missionViewHub: MissionViewHub;
  private readonly externalSessionsHub: ExternalSessionsHub;
  private readonly mailboxRegistry: MailboxRegistry;
  private readonly objectModel: ObjectModel;
  private readonly messagingLive: MessagingLive;
  private messagingV2: MessagingV2Handle | null = null;
  private seatWatchTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogId: string | null = null;
  private watchdogSession: MessagingSession | null = null;
  /** D-N6-2: the one token store shared by the authority, the lane glue,
   * spawn env injection, and the in-process consumers (never printed). */
  private readonly tokenStore = createTokenStore();
  /** D-N8-1: external principals (PartnerChris) — provision/list/revoke via
   * the CLI's REST surface; the fleet roster and policy sync read it. */
  private readonly externalsStore = createExternalsStore();

  constructor(
    private readonly port: number,
    private readonly coordinator: AgentCoordinator,
    private readonly stateManager: StateManager, terminals: TerminalRuntime,
    private readonly options: ServerOptions = {},
  ) {
    // One durable mailbox registry shared by messaging routing and spawn-name
    // checks. NVK_MAILBOX_STORE pins the file for non-Live stacks (scratch
    // backends must write the REAL registry or their evidence is hollow).
    this.mailboxRegistry = new MailboxRegistry(process.env.NVK_MAILBOX_STORE || undefined);
    this.objectModel = this.buildObjectModel();
    this.agentsHub = this.buildAgentsHub(terminals);
    this.projectsHub = new ProjectsHub(this.agentsHub);
    [this.canvasHub, this.analyticsHub, this.designHub] = this.buildStudioHubs();
    this.messagingHub = this.buildMessagingHub(); this.missionViewHub = this.buildMissionViewHub();
    this.externalSessionsHub = this.buildExternalSessionsHub();
    this.messagingLive = this.buildMessagingLive();
    this.server = createServer(this.app);
    this.wsServer = new WebSocketServer({ server: this.server });
    this.createAppListener();
    this.configureExpress();
    this.configureWebSockets();
    this.configureRoutes();
    this.registerTokenRoutes();
    this.configureStaticFallback();
    this.coordinator.setBroadcastHandler((event, payload) => this.broadcastEvent(event, payload));
  }

  /** N4 (D-N4-1): per-connection messaging-v2 subscriptions as the human
   * session — the human principal arrives with the capability (N3.1). */
  private buildMessagingLive(): MessagingLive {
    return createMessagingLive({
      humanSession: () => this.messagingV2?.lanes?.humanSession() ?? null,
      'log': (line) => console.log(line),
    });
  }

  /** Optional same-origin app listener — prod serves the built frontend here. */
  private createAppListener(): void {
    if (!this.options.appPort) return;
    this.appServer = createServer(this.app);
    this.appWss = new WebSocketServer({ server: this.appServer });
  }

  /** Studio lenses share one event broadcast boundary. */
  private buildStudioHubs(): [CanvasHub, AnalyticsHub, DesignHub] {
    const broadcast = (event: string, payload: unknown): void => this.broadcastEvent(event, payload);
    return [new CanvasHub(broadcast), new AnalyticsHub(broadcast), new DesignHub(broadcast)];
  }

  /**
   * The durable mission graph (plan v2 §1.2): roots injected exactly here —
   * same env overrides as the MissionView read side, so a scratch backend
   * points BOTH sides at the same fixture directory.
   */
  private buildObjectModel(): ObjectModel {
    return new ObjectModel({
      storesDir: process.env.NVK_MISSION_STORES_DIR ?? path.resolve('.novakai/stores'),
      baselinePath: process.env.NVK_STORES_BASELINE ?? path.resolve('stores-baseline.json'),
    });
  }

  private buildAgentsHub(terminals: TerminalRuntime): AgentsHub {
    return new AgentsHub(
      this.activeSockets,
      terminals,
      (name) => this.mailboxRegistry.identityFor(name),
      this.objectModel,
      undefined, // nudgeRecordPath — production default
      this.tokenStore,
    );
  }

  /**
   * The messaging sliver (N4): mailbox registry routes + POST /api/threads.
   * Everything message-shaped lives in the capability now — the old tunnel
   * routes, router, delivery, and broadcasts are deleted.
   */
  private buildMessagingHub(): MessagingHub {
    return new MessagingHub({
      mailboxRegistry: this.mailboxRegistry,
      missionGraph: this.objectModel,
      roomsStorePath: process.env.NVK_MISSION_ROOMS ?? path.resolve('.novakai-command/rooms.jsonl'),
    });
  }

  /**
   * External-session registration (mission_external-session-visibility):
   * terminal-spawned sessions join the durable mission graph. Composes the
   * object model, the shared mailbox registry, the messaging send seam, and
   * the live roster (for the one rejecting collision) — nothing else.
   */
  /**
   * External-session registration (mission_external-session-visibility):
   * terminal-spawned sessions join the durable mission graph. N4: the
   * announcement DM goes through the capability — authenticate as the
   * external agent's durable agentId, send to the human principal.
   */
  private buildExternalSessionsHub(): ExternalSessionsHub {
    return new ExternalSessionsHub(
      this.objectModel,
      this.mailboxRegistry,
      (agentId, body) => this.sendExternalAnnouncement(agentId, body),
      () => rosterFromAgents(this.agentsHub.terminals.list()).map((agent) => agent.name),
    );
  }

  /** The capability-backed announcement: agentId → human personId (N4).
   * D-N6-2: the credential is the store's issued token (agentId is not one). */
  private async sendExternalAnnouncement(agentId: string, body: string): Promise<{ id: string }> {
    const handle = this.messagingV2;
    if (handle === null) throw new Error('messaging capability unavailable this run');
    this.tokenStore.ensure(agentId);
    const token = this.tokenStore.tokenForAgent(agentId);
    if (token === null) throw new Error(`no credential held for ${agentId}`);
    const auth = await handle.embedded.authenticate({ token });
    if (auth.kind !== 'authenticated') throw new Error(`external agent ${agentId} is not authenticatable`);
    const accepted = await auth.session.sendMessage({
      address: `person:${HUMAN_PERSON_ID}`,
      body: { text: body },
      priority: 'normal',
      clientMessageId: `msg_${randomUUID()}`,
    });
    if (accepted.kind !== 'ok') throw new Error(accepted.error.message);
    return { id: accepted.value.messageId };
  }

  /** F3: the identity (refs unioned across every team + mission) must exist
   * BEFORE messagingV2's boot policy syncs, or recipients' allowlists lack
   * the watchdog and its alerts terminally fail delivery. Failure → null →
   * log-only sink, never a boot blocker. */
  private ensureWatchdogIdentitySafely(): string | null {
    try {
      return ensureWatchdogIdentity(this.objectModel);
    } catch (error) {
      console.error('[seatWatch] watchdog identity failed — alerts are log-only this run:', error);
      return null;
    }
  }

  /** F8: ONE authenticated session for every seat alert (authenticate-per-
   * alert leaked a session each time). A rejected send drops the cache so an
   * expired session re-authenticates on the next alert. */
  private async seatAlertSession(watchdogId: string): Promise<MessagingSession | null> {
    if (this.watchdogSession !== null) return this.watchdogSession;
    this.tokenStore.ensure(watchdogId);
    const token = this.tokenStore.tokenForAgent(watchdogId);
    if (token === null) return null;
    const auth = await this.messagingV2?.embedded.authenticate({ token });
    if (auth?.kind !== 'authenticated') return null;
    this.watchdogSession = auth.session;
    return this.watchdogSession;
  }

  /** One #team alert through the capability, sent AS the watchdog agent. */
  private async sendSeatAlert(watchdogId: string, body: string): Promise<void> {
    const threadId = this.messagingV2?.rooms?.fleetThreadId();
    if (threadId === undefined) return console.log(`[seatWatch] unsent (no fleet room): ${body}`);
    const session = await this.seatAlertSession(watchdogId);
    if (session === null) return console.log(`[seatWatch] unsent (identity rejected): ${body}`);
    const accepted = await session.sendMessage({
      address: `thread:${threadId}`, body: { text: body },
      priority: 'normal', clientMessageId: `wd_${randomUUID()}`,
    });
    if (accepted.kind !== 'ok') {
      this.watchdogSession = null;
      console.error(`[seatWatch] alert rejected: ${accepted.error.message}`);
    }
  }

  private postSeatAlert(watchdogId: string, body: string): void {
    this.sendSeatAlert(watchdogId, body).catch((error: unknown) => {
      console.error(`[seatWatch] alert failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** D-N6-2/D-N6-5: the owner CLI's token surface (localhost trust boundary,
   * same posture as /api/agents). Issue returns the raw token ONCE — the
   * caller (nvk-agent) prints it; nothing here logs it. Issuance also runs
   * the D-N2-5 policy sync so a fresh external's first message never 403s
   * on the human's deny-by-default contact policy. */
  private registerTokenRoutes(): void {
    this.app.post('/api/messaging/v2/tokens', (request, response) => void this.issueToken(request, response));
    this.app.post('/api/messaging/v2/tokens/revoke', (request, response) => this.revokeTokens(request, response));
    this.app.get('/api/messaging/v2/tokens', (request, response) => this.listTokens(request, response));
    // D-N8-1: external principals (the PartnerChris surface).
    this.app.post('/api/messaging/v2/externals', (request, response) => void this.provisionExternal(request, response));
    this.app.get('/api/messaging/v2/externals', (_request, response) => this.listExternals(response));
    this.app.post('/api/messaging/v2/externals/revoke', (request, response) => this.revokeExternal(request, response));
  }

  /** D-N8-1: provision an external principal + mint its door token (printed
   * ONCE, agent-token posture) + the D-N6-5-style policy sync so its first
   * room send never 403s on deny-by-default. */
  private async provisionExternal(request: express.Request, response: express.Response): Promise<void> {
    const { slackUserId, displayName } = request.body ?? {};
    if (typeof slackUserId !== 'string' || slackUserId === '' || typeof displayName !== 'string' || displayName === '') {
      response.status(400).json({ error: 'slackUserId and displayName are required' });
      return;
    }
    const external = this.externalsStore.provision({ slackUserId, displayName });
    const { token } = this.tokenStore.issueExternal(external.personId);
    await this.messagingV2?.lanes?.syncPoliciesNow();
    response.status(201).json({ personId: external.personId, recordId: external.id, token });
  }

  private listExternals(response: express.Response): void {
    response.json({ externals: this.externalsStore.list() });
  }

  /** Revoking an external kills its principal AND its tokens (both stores). */
  private revokeExternal(request: express.Request, response: express.Response): void {
    const slackUserId = request.body?.slackUserId;
    if (typeof slackUserId !== 'string' || slackUserId === '') {
      response.status(400).json({ error: 'slackUserId is required' });
      return;
    }
    const revoked = this.externalsStore.revokeBySlackUser(slackUserId);
    let tokensRevoked = 0;
    for (const record of revoked) tokensRevoked += this.tokenStore.revokeAllForExternal(record.personId).length;
    response.json({ revoked: revoked.length, tokensRevoked });
  }

  private agentIdOrReply(request: express.Request, response: express.Response): string | null {
    const candidate = request.body?.agentId ?? request.query['agentId'];
    if (typeof candidate !== 'string' || this.objectModel.agentRecord(candidate) === null) {
      response.status(404).json({ error: 'unknown durable agent' });
      return null;
    }
    return candidate;
  }

  private async issueToken(request: express.Request, response: express.Response): Promise<void> {
    const agentId = this.agentIdOrReply(request, response);
    if (agentId === null) return;
    const { token, record } = this.tokenStore.issue(agentId);
    await this.messagingV2?.lanes?.syncPoliciesNow(); // D-N6-5: allowlists union now
    response.status(201).json({ agentId, recordId: record.id, token });
  }

  private revokeTokens(request: express.Request, response: express.Response): void {
    const agentId = this.agentIdOrReply(request, response);
    if (agentId === null) return;
    response.json({ agentId, revoked: this.tokenStore.revokeAll(agentId).length });
  }

  private listTokens(request: express.Request, response: express.Response): void {
    const agentId = this.agentIdOrReply(request, response);
    if (agentId === null) return;
    response.json({ agentId, tokens: this.tokenStore.listFor(agentId) });
  }

  /** D-N5-6: the revived seat-watch (Chris's overrule of N5's accepted
   * loss). Ticks over transcript mtimes — never a journal — on the config
   * interval; the boot tick baselines silently before the first post. */
  private startSeatWatch(): void {
    const watchdogId = this.watchdogId;
    if (watchdogId === null) console.warn('[seatWatch] no watchdog identity — alerts are log-only this run');
    const onAlert = watchdogId === null
      ? (body: string) => console.log(`[seatWatch] ${body}`)
      : (body: string) => this.postSeatAlert(watchdogId, body);
    const watch = createSeatWatch({
      terminals: this.agentsHub.terminals, onAlert, extraIgnoreTitles: [WATCHDOG_AGENT_NAME],
    });
    this.agentsHub.attachSeatWatch(watch);
    tickSafely(watch);
    this.seatWatchTimer = setInterval(() => tickSafely(watch), watch.intervalSec() * 1000);
    this.seatWatchTimer.unref();
  }

  /** A seat-watch boot failure must never take down the app (N1's rule). */
  private startSeatWatchSafely(): void {
    try {
      this.startSeatWatch();
    } catch (error) {
      console.error('[seatWatch] boot failed — disabled this run:', error);
    }
  }

  /**
   * Mission Room V1 (mission_mission-room-v1): read-only snapshot hub. Roots
   * are resolved explicitly here — env overrides for the dev-lane worktree,
   * repo-relative paths for the Live lane — never inside the module (S1).
   */
  private buildMissionViewHub(): MissionViewHub {
    return new MissionViewHub({
      storesDir: process.env.NVK_MISSION_STORES_DIR ?? path.resolve('.novakai/stores'),
      workDir: process.env.NVK_MISSION_WORK_DIR ?? path.resolve('.novakai/work'),
      journalPath: defaultCapabilityJournalPath(),
      registryPath: process.env.NVK_MISSION_REGISTRY ?? path.resolve('.novakai-command/agents.json'),
      roomsPath: process.env.NVK_MISSION_ROOMS ?? path.resolve('.novakai-command/rooms.jsonl'),
    });
  }

  private configureExpress(): void {
    this.app.use(cors({ origin: 'http://localhost:3030' }));
    this.app.use(express.json());
    if (this.options.staticDir) {
      this.app.use(express.static(this.options.staticDir));
    }
  }

  private configureWebSockets(): void {
    this.attachConnectionHandler(this.wsServer);
    if (this.appWss) this.attachConnectionHandler(this.appWss);
  }

  /** One client frame: messaging-v2-sub is per-connection (never AgentsHub). */
  private handleSocketFrame(socket: WebSocket, data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString()) as { type?: string; since?: unknown };
      if (message.type === 'messaging-v2-sub') {
        void this.messagingLive.subscribe(socket, typeof message.since === 'string' ? message.since : undefined);
        return;
      }
      this.agentsHub.handleMessage(socket, message as Record<string, unknown>);
    } catch {
      // ignore malformed messages
    }
  }

  private attachConnectionHandler(socketServer: WebSocketServer): void {
    // ws re-emits http-server errors on the WebSocketServer; without this
    // listener a listen() failure crashes as an unhandled 'error' event.
    socketServer.on('error', () => {});
    socketServer.on('connection', (socket) => {
      this.activeSockets.add(socket);
      socket.on('message', (data) => this.handleSocketFrame(socket, data));
      socket.on('close', () => {
        this.activeSockets.delete(socket);
        this.messagingLive.close(socket);
        this.agentsHub.handleClose(socket);
      });
    });
  }

  /**
   * SPA fallback for the built frontend: any non-/api GET returns index.html so
   * client-side routing works on reload. Registered after all API routes.
   */
  private configureStaticFallback(): void {
    const staticDir = this.options.staticDir;
    if (!staticDir) return;
    this.app.get('*', (request, response, next) => {
      if (request.path.startsWith('/api')) {
        next();
        return;
      }
      response.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  /**
   * Identity/health: lets the desktop shell prove a :3030 responder really is
   * a Live snapshot serve (`static: true`) before attaching, and lets deploy
   * verification read the serving snapshot's sha. A vite-proxied dev backend
   * answers `static: false` and is refused by the shell.
   */
  private healthPayload(): Record<string, unknown> {
    return {
      application: 'novakai-command',
      serverPort: this.port,
      appPort: this.options.appPort ?? null,
      static: Boolean(this.options.staticDir),
      snapshotSha: this.snapshotSha(),
    };
  }

  /** Full sha from the serving snapshot's manifest (staticDir = <snap>/dist/frontend). */
  private snapshotSha(): string | null {
    if (!this.options.staticDir) return null;
    try {
      const manifestPath = path.join(this.options.staticDir, '..', '..', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { sha?: string };
      return manifest.sha ?? null;
    } catch {
      return null;
    }
  }

  private configureRoutes(): void {
    this.app.get('/api/health', (_request, response) => {
      response.json(this.healthPayload());
    });

    this.agentsHub.registerRoutes(this.app);
    this.projectsHub.registerRoutes(this.app);
    this.canvasHub.registerRoutes(this.app);
    this.analyticsHub.registerRoutes(this.app);
    this.designHub.registerRoutes(this.app);
    this.messagingHub.registerRoutes(this.app);
    registerMessagingV2Routes(this.app, {
      getHandle: () => this.messagingV2,
      terminals: this.agentsHub.terminals,
      objectModel: this.objectModel,
    });
    // N4 (D-N4-3): the browser's server-owned human surface.
    registerMessagingV2UserRoutes(this.app, {
      getHandle: () => this.messagingV2,
      terminals: this.agentsHub.terminals,
      objectModel: this.objectModel,
    });
    this.missionViewHub.registerRoutes(this.app);
    this.externalSessionsHub.registerRoutes(this.app);
    new PeopleHub(this.objectModel, () => this.agentsHub.terminals.list(), process.env.NVK_MISSION_ROOMS ?? path.resolve('.novakai-command/rooms.jsonl'), { journalPath: defaultCapabilityJournalPath() }).registerRoutes(this.app);

    this.app.get('/api/config', (_, res) => {
      res.json(ConfigManager.load());
    });

    this.app.post('/api/config', (req, res) => {
      ConfigManager.save(req.body);
      res.json({ success: true });
    });

    this.app.get('/api/builds', (_, res) => {
      res.json(this.stateManager.listBuilds());
    });

    this.app.get('/api/builds/:id', (req, res) => {
      try {
        res.json(this.stateManager.loadBuild(req.params.id));
      } catch {
        res.status(404).json({ error: 'Build not found' });
      }
    });

    this.app.post('/api/builds/start', async (req, res) => {
      const { prompt, llmType, geminiApiKey, resumeSessionId } = req.body;
      try {
        const buildId = await this.coordinator.startBuild(prompt, llmType, geminiApiKey, resumeSessionId);
        res.json({ buildId });
      } catch (error) {
        if (error instanceof Error && error.message === 'BUILD_BUSY') {
          res.status(409).json({ error: 'A build is already running' });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.app.post('/api/builds/stop', async (req, res) => {
      const { buildId } = req.body;
      await this.coordinator.stopBuild(buildId);
      res.json({ success: true });
    });

    this.app.post('/api/subagents/spawn', async (req, res) => {
      const { parentAgentId, role, prompt, llmType, geminiApiKey } = req.body;
      const subagentId = await this.coordinator.spawnSubagent(parentAgentId, role, prompt, llmType, geminiApiKey);
      res.json({ subagentId });
    });

    this.app.post('/api/browse', (_, res) => {
      // ponytail: route the picker through System Events so a background node
      // process can present the GUI dialog; bare `choose folder` errors instantly.
      const appleScript = `osascript -e 'tell application "System Events" to POSIX path of (choose folder with prompt "Select Workspace Folder")'`;
      exec(appleScript, (error, stdout) => {
        if (error) {
          res.status(500).json({ error: 'Folder selection cancelled' });
        } else {
          res.json({ path: stdout.trim() });
        }
      });
    });

    // ===== Transcript API (reads from ~/.claude/projects/) =====

    this.app.get('/api/sessions', async (_request, response) => {
      try {
        const configuration = ConfigManager.load();
        if (!configuration.activeRepo) {
          response.json([]);
          return;
        }
        response.json(await matchSessions(configuration.activeRepo));
      } catch (error) {
        response.status(500).json({ error: String(error) });
      }
    });

    const validateTranscriptParams = (
      request: express.Request,
      response: express.Response
    ): { projectDir: string; sessionId: string } | null => {
      const params = validateProjectSession(request, response);
      if (!params) return null;
      const resolved = path.resolve(CLAUDE_DIR, params.projectDir);
      if (!resolved.startsWith(CLAUDE_DIR + path.sep)) {
        response.status(400).json({ error: 'invalid path' });
        return null;
      }
      return params;
    };

    this.app.get('/api/transcript', (request, response) => {
      const params = validateTranscriptParams(request, response);
      if (!params) return;
      const sessions = listSessions(params.projectDir);
      const session = sessions.find(entry => entry.sessionId === params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      response.json(readSession(session.filePath));
    });

    this.app.get('/api/usage', (request, response) => {
      const params = validateTranscriptParams(request, response);
      if (!params) return;
      const session = listSessions(params.projectDir).find(entry => entry.sessionId === params.sessionId);
      if (!session) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      response.json(sessionUsage(session.filePath, params.projectDir, params.sessionId));
    });

    // ===== Subagent transcript API =====

    const validateSubagentParams = (
      request: express.Request,
      response: express.Response,
      requireAgent: boolean
    ): { projectDir: string; sessionId: string; agentId: string } | null => {
      const params = validateProjectSession(request, response);
      if (!params) return null;
      const agentId = request.query.agent as string;
      if (requireAgent && (typeof agentId !== 'string' || !AGENT_RE.test(agentId))) {
        response.status(400).json({ error: 'invalid agent parameter' });
        return null;
      }
      const targetPath = path.resolve(CLAUDE_DIR, params.projectDir, params.sessionId, 'subagents');
      if (!targetPath.startsWith(CLAUDE_DIR + path.sep)) {
        response.status(400).json({ error: 'invalid path' });
        return null;
      }
      return { ...params, agentId };
    };

    this.app.get('/api/subagents', (req, res) => {
      const params = validateSubagentParams(req, res, false);
      if (!params) return;
      res.json(listSubagents(params.projectDir, params.sessionId));
    });

    this.app.get('/api/subagent-transcript', (req, res) => {
      const params = validateSubagentParams(req, res, true);
      if (!params) return;
      const events = readSubagent(params.projectDir, params.sessionId, params.agentId);
      if (events === null) {
        res.status(404).json({ error: 'Subagent transcript not found' });
        return;
      }
      res.json(events);
    });

    // ===== Ruleset API (reads from project repo) =====

    this.app.get('/api/ruleset', (_request, response) => {
      const configuration = ConfigManager.load();
      if (!configuration.activeRepo) {
        response.json({ hooks: [], gates: [], claudeMd: null, claudeMdPath: null, projectPath: '', toolsPath: null });
        return;
      }
      try {
        response.json(readRuleset(configuration.activeRepo));
      } catch (error) {
        response.status(500).json({ error: String(error) });
      }
    });

    // ===== Filesystem Explorer API =====

    const sendFsError = (res: express.Response, e: unknown): void => {
      if (e instanceof PathDeniedError || (e as NodeJS.ErrnoException)?.code === 'EACCES') {
        res.status(403).json({ error: e instanceof Error ? e.message : String(e) });
      } else if (e instanceof NotFoundError || (e as NodeJS.ErrnoException)?.code === 'ENOENT') {
        res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
      } else {
        res.status(500).json({ error: String(e) });
      }
    };

    this.app.get('/api/fs', (req, res) => {
      const targetPath = req.query.path as string;
      const showHidden = req.query.showHidden === 'true';
      try {
        res.json(listDir(targetPath, showHidden));
      } catch (e) {
        sendFsError(res, e);
      }
    });

    this.app.get('/api/fs/resolve-root', (req, res) => {
      const targetPath = req.query.path as string;
      try {
        res.json(resolveGitRoot(targetPath));
      } catch (e) {
        sendFsError(res, e);
      }
    });

    // Thin adapter over the version-control module. clampToHome + error
    // mapping happen inside getRepoInfo → resolveGitRoot (outside-$HOME → 403);
    // a valid in-sandbox dir degrades to nulls rather than 500.
    this.app.get('/api/repo-info', async (request, response) => {
      const targetPath = request.query.path as string;
      try {
        response.json(await getRepoInfo(targetPath));
      } catch (error) {
        sendFsError(response, error);
      }
    });

    this.app.post('/api/active-repo', (req, res) => {
      const rawPath = req.body?.path as string;
      const resolved = clampToHome(rawPath);
      if (resolved === null) {
        res.status(403).json({ error: 'Path denied' });
        return;
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        res.status(404).json({ error: 'Not a directory' });
        return;
      }
      const configuration = ConfigManager.load();
      configuration.activeRepo = resolved;
      ConfigManager.save(configuration);
      res.json({ activeRepo: resolved });
    });

    this.app.get('/api/active-repo', (_, res) => {
      const configuration = ConfigManager.load();
      res.json({ activeRepo: configuration.activeRepo ?? null });
    });
  }

  public broadcastEvent(event: string, payload: any): void {
    const rawMessage = JSON.stringify({ event, payload });
    for (const socket of this.activeSockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(rawMessage);
      }
    }
  }

  public async start(): Promise<void> {
    await this.listen(this.server, this.port);
    if (this.appServer && this.options.appPort) {
      await this.listen(this.appServer, this.options.appPort);
    }
    this.watchdogId = this.ensureWatchdogIdentitySafely();
    await this.bootMessagingV2Safely();
    this.startSeatWatchSafely();
  }

  /** A v2 boot failure must never take down the app (the old surface still
   * serves). Fail LOUD, continue — the v2 routes answer 503 this run. */
  private async bootMessagingV2Safely(): Promise<void> {
    try {
      this.messagingV2 = await startMessagingV2({
        objectModel: this.objectModel,
        storePath: process.env.NVK_MESSAGING_V2_STORE || undefined,
        tokenStore: this.tokenStore,
        externalsStore: this.externalsStore,
        humanToken: process.env.NVK_MESSAGING_V2_HUMAN_TOKEN || undefined,
        // D-N6-1: the DEC-17 door — production defaults to 3032 on localhost;
        // scratch backends (NOVAKAI_SERVER_PORT set) stay doorless so parallel
        // rigs never fight over the port. Remote reachability is the owner's
        // opt-in via NVK_MESSAGING_V2_DOOR_HOST (docs/operations/CONNECT-EXTERNAL.md).
        ...(process.env.NOVAKAI_SERVER_PORT ? {} : {
          door: {
            port: Number(process.env.NVK_MESSAGING_V2_DOOR_PORT) || 3032,
            host: process.env.NVK_MESSAGING_V2_DOOR_HOST || '127.0.0.1',
          },
        }),
        // N2: the agent direct lane — pty presence transport over the terminal
        // runtime; the glue opens lanes for live agents and briefs new spawns.
        terminals: this.agentsHub.terminals,
        onLaunch: (listener) => this.agentsHub.onLaunch(listener),
      });
    } catch (error) {
      console.error('[messaging-v2] boot failed — capability disabled this run:', error);
    }
  }

  private listen(server: HttpServer, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(
            `[Novakai Command Backend] Port ${port} is already in use — a stale server is probably still running.\n` +
            `Free it with: lsof -ti:${port} | xargs kill`
          );
        }
        reject(error);
      });
      server.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    // The seat-watch timer touches transcripts only; clear it before anything
    // else so a late tick can never fire into a half-closed capability.
    if (this.seatWatchTimer !== null) {
      clearInterval(this.seatWatchTimer);
      this.seatWatchTimer = null;
    }
    // messagingV2 closes FIRST — it is additive (N1) and holds the journal
    // handle; nothing else depends on it yet. A close failure must not abort
    // shutdown (N1 audit finding 6): log it, keep closing the real servers.
    try {
      await this.messagingV2?.close();
    } catch (error) {
      console.error('[messaging-v2] close failed during shutdown — continuing:', error);
    }
    this.messagingV2 = null;
    const wsServers = this.appWss ? [this.wsServer, this.appWss] : [this.wsServer];
    const httpServers = this.appServer ? [this.server, this.appServer] : [this.server];
    await Promise.all(wsServers.map((socketServer) => new Promise<void>((resolve) => socketServer.close(() => resolve()))));
    await Promise.all(httpServers.map((httpServer) => new Promise<void>((resolve) => httpServer.close(() => resolve()))));
  }
}

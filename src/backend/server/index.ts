import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
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
import { ExternalSessionsHub } from '../externalSessions/index.js';
import { PeopleHub } from '../people/index.js';
import type { TerminalRuntime } from '../terminal/runtime/index.js';

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
  private messagingV2: MessagingV2Handle | null = null;

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
    this.server = createServer(this.app);
    this.wsServer = new WebSocketServer({ server: this.server });
    this.createAppListener();
    this.configureExpress();
    this.configureWebSockets();
    this.configureRoutes();
    this.configureStaticFallback();
    this.coordinator.setBroadcastHandler((event, payload) => this.broadcastEvent(event, payload));
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
    );
  }

  /**
   * Agent messaging tunnel (docs/agent-messaging.md): envelopes broadcast on
   * the shared ws so the Messages view can build a live feed; new agents get
   * their spawn briefing typed into their PTY.
   */
  private buildMessagingHub(): MessagingHub {
    const messagingHub = new MessagingHub(
      this.agentsHub.terminals,
      (event, payload) => this.broadcastEvent(event, payload),
      {
        serverPort: this.port, mailboxRegistry: this.mailboxRegistry, missionGraph: this.objectModel,
        // NVK_MESSAGE_STORE pins the journal for non-Live stacks (same
        // discipline as NVK_MISSION_STORES_DIR — scratch evidence stays real).
        storePath: process.env.NVK_MESSAGE_STORE || undefined,
        // A scratch backend sharing the REAL journal must not reconcile it:
        // its roster is empty, so retry/confirmation amendments would falsify
        // envelopes the Live lane can still deliver. Default unchanged.
        reconcileOnStart: process.env.NVK_RECONCILE_ON_START !== 'off',
      },
    );
    this.agentsHub.onLaunch((info) => messagingHub.handleAgentSpawned(info));
    return messagingHub;
  }

  /**
   * External-session registration (mission_external-session-visibility):
   * terminal-spawned sessions join the durable mission graph. Composes the
   * object model, the shared mailbox registry, the messaging send seam, and
   * the live roster (for the one rejecting collision) — nothing else.
   */
  private buildExternalSessionsHub(): ExternalSessionsHub {
    return new ExternalSessionsHub(
      this.objectModel,
      this.mailboxRegistry,
      (from, message) => this.messagingHub.send.send(from, message),
      () => rosterFromAgents(this.agentsHub.terminals.list()).map((agent) => agent.name),
    );
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
      journalPath: process.env.NVK_MISSION_JOURNAL ?? path.resolve('.novakai-command/messages.jsonl'),
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

  private attachConnectionHandler(socketServer: WebSocketServer): void {
    // ws re-emits http-server errors on the WebSocketServer; without this
    // listener a listen() failure crashes as an unhandled 'error' event.
    socketServer.on('error', () => {});
    socketServer.on('connection', (socket) => {
      this.activeSockets.add(socket);

      socket.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.agentsHub.handleMessage(socket, message);
        } catch {
          // ignore malformed messages
        }
      });

      socket.on('close', () => {
        this.activeSockets.delete(socket);
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
    this.missionViewHub.registerRoutes(this.app);
    this.externalSessionsHub.registerRoutes(this.app);
    new PeopleHub(this.objectModel, () => this.agentsHub.terminals.list(), process.env.NVK_MISSION_ROOMS ?? path.resolve('.novakai-command/rooms.jsonl'), { journalPath: process.env.NVK_MISSION_JOURNAL ?? path.resolve('.novakai-command/messages.jsonl') }).registerRoutes(this.app);

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
    try {
      this.messagingV2 = await startMessagingV2({
        objectModel: this.objectModel,
        storePath: process.env.NVK_MESSAGING_V2_STORE || undefined,
        humanToken: process.env.NVK_MESSAGING_V2_HUMAN_TOKEN || undefined,
      });
    } catch (error) {
      // N1 is additive with zero consumers — a v2 boot failure must never take
      // down the app (the old surface still serves). Fail LOUD, continue.
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

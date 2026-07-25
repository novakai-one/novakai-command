import { spawn as spawnPty } from 'node-pty';
import type { IPty } from 'node-pty';
import type { AppConfig } from '../../config/index.js';
import type { ProviderId } from '../../../shared/project/schema.js';
import { ConfigManager } from '../../config/index.js';
import { resolveCli } from '../../agent/executor/index.js';
import { CodexSessionLocator } from './codexDiscovery.js';
import { KimiSessionLocator } from './kimi/index.js';

/** Minimal PTY interface consumed by the persistent terminal module. */
export type ProviderTerminalProcess =
  Pick<IPty, 'onData' | 'onExit' | 'write' | 'resize' | 'kill'>
  & Partial<Pick<IPty, 'pid'>>;

/** Spawn result whose provider session identity may resolve asynchronously. */
export interface ProviderLaunch {
  process: ProviderTerminalProcess;
  sessionId: Promise<string>;
  cancelSessionWait?(reason?: string): void;
}

/** Injectable provider launcher used by TerminalManager and its tests. The
 * optional agentId is the spawn's adopted identity (durable for mission
 * spawns, runtime-minted otherwise) — injected into the child env (N2). */
export type ProviderLauncher = (
  provider: ProviderId,
  cwd: string,
  requestedSessionId: string,
  agentId?: string,
) => ProviderLaunch;

interface ProviderSpec {
  /** CLI argv; interactive TUI launches take no session flag unless the CLI owns one. */
  args(requestedSessionId: string): string[];
  /** Provider-owned env vars to strip from the inherited environment. */
  scrub(envKey: string): boolean;
  /** Configured CLI path (absolute or on-PATH name). */
  cliPath(configuration: AppConfig): string | undefined;
  /** Spawn the PTY and resolve the authoritative session id. */
  launch(cwd: string, requestedSessionId: string, agentId?: string): ProviderLaunch;
}

function launchClaude(cwd: string, requestedSessionId: string, agentId?: string): ProviderLaunch {
  return {
    process: spawn('claude', cwd, PROVIDERS.claude.args(requestedSessionId), requestedSessionId, agentId),
    sessionId: Promise.resolve(requestedSessionId),
  };
}

function launchCodex(cwd: string, requestedSessionId: string, agentId?: string): ProviderLaunch {
  const locator = new CodexSessionLocator();
  const known = locator.snapshot();
  const startedAt = Date.now();
  const launched = spawn('codex', cwd, PROVIDERS.codex.args(requestedSessionId), requestedSessionId, agentId);
  return {
    process: launched,
    sessionId: locator.waitForNew(cwd, known, startedAt),
    cancelSessionWait: (reason) => locator.cancel(reason),
  };
}

function launchKimi(cwd: string, requestedSessionId: string, agentId?: string): ProviderLaunch {
  const locator = new KimiSessionLocator();
  const known = locator.snapshot();
  const launched = spawn('kimi', cwd, PROVIDERS.kimi.args(requestedSessionId), requestedSessionId, agentId);
  return {
    process: launched,
    sessionId: locator.waitForNew(cwd, known),
    cancelSessionWait: (reason) => locator.cancel(reason),
  };
}

const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  claude: {
    args: (requestedSessionId) => ['--session-id', requestedSessionId],
    scrub: () => false,
    cliPath: (configuration) => configuration.claudeCliPath,
    launch: launchClaude,
  },
  codex: {
    args: () => ['-c', 'check_for_update_on_startup=false', '--no-alt-screen'],
    scrub: (envKey) => /^CODEX_/.test(envKey) && envKey !== 'CODEX_HOME',
    cliPath: (configuration) => configuration.codexCliPath,
    launch: launchCodex,
  },
  kimi: {
    args: () => [],
    scrub: (envKey) => /^KIMI_/.test(envKey),
    cliPath: (configuration) => configuration.kimiCliPath,
    launch: launchKimi,
  },
};

export function providerArguments(provider: ProviderId, requestedSessionId: string): string[] {
  return PROVIDERS[provider].args(requestedSessionId);
}

export function providerEnvironment(
  provider: ProviderId,
  browserSession?: string,
  serverPort?: number,
  agentId?: string,
): NodeJS.ProcessEnv {
  const scrubbed = { ...process.env };
  for (const envKey of Object.keys(scrubbed)) {
    if (/^CLAUDE|^ANTHROPIC/.test(envKey)) delete scrubbed[envKey];
    if (PROVIDERS[provider].scrub(envKey)) delete scrubbed[envKey];
  }
  scrubbed.TERM = 'xterm-256color';
  // Bind each agent to its own isolated browser session. When the agent runs
  // `browse`, it auto-scopes to this id — parallel agents never share a tab.
  if (browserSession) scrubbed.NVK_SESSION = browserSession;
  // N2: the agent's messaging credential is its adopted agentId (durable for
  // mission spawns, runtime-minted otherwise — the latter simply never
  // authenticates). nvk-msg reads it; the briefing never prints it.
  if (agentId) scrubbed.NVK_AGENT_ID = agentId;
  // Lane-local tunnel routing: THIS backend's own port is authoritative for
  // its agents' nvk-msg / nvk-live, even when the parent environment carries
  // another backend's NVK_COMMAND_URL — a dev backend started from a
  // Live-spawned terminal must not route its agents to the Live tunnel.
  if (serverPort) {
    scrubbed.NVK_COMMAND_URL = `http://127.0.0.1:${serverPort}`;
  }
  return scrubbed;
}

function spawn(
  provider: ProviderId,
  cwd: string,
  args: string[],
  browserSession: string,
  agentId?: string,
): ProviderTerminalProcess {
  const configuration = ConfigManager.load();
  const serverPort = Number(process.env.NOVAKAI_SERVER_PORT) || configuration.serverPort;
  const configured = PROVIDERS[provider].cliPath(configuration);
  const { resolved, exists } = resolveCli(configured || provider);
  if (!exists) {
    throw new Error(`${provider} CLI not found (looked for "${configured || provider}"). `
      + `Set ${provider}CliPath in .novakai-command/config.json or start the backend from a shell with ${provider} on PATH.`);
  }
  return spawnPty(resolved, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: providerEnvironment(provider, browserSession, serverPort, agentId),
  });
}

/** Launch a provider CLI while resolving its authoritative session ID. */
export function launchProvider(
  provider: ProviderId,
  cwd: string,
  requestedSessionId: string,
  agentId?: string,
): ProviderLaunch {
  return PROVIDERS[provider].launch(cwd, requestedSessionId, agentId);
}

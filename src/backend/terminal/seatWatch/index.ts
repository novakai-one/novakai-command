// Seat watch (D-N5-6): the revived in-app seat half of the deleted
// scripts/nvk-watchdog.mjs — Chris overruled the "accepted loss" (N5 slice).
// Liveness = transcript mtime per seat, never the roster status. Boundaries
// come from .novakai-command/watchdog.json (same file the script honored).
// checkDeliveries stays dead (DeliveryUpdated replaced it); the script's
// jsonl/json persistence is replaced by in-memory state + an injected alert
// sink — a backend restart re-baselines silently by design.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentInfo } from '../manager.js';
import { CLAUDE_DIR } from '../../transcript/parser.js';

export interface SeatBoundary {
  quietAfterSec: number;
  escalate: string;
}

export interface SeatOverride {
  agentId?: string;
  title?: string;
  quietAfterSec?: number;
  escalate?: string;
}

export interface SeatWatchConfig {
  intervalSec: number;
  defaults: SeatBoundary;
  /** Per-seat overrides match by agentId first, then exact title. */
  seats: SeatOverride[];
  /** Titles the watch never alerts on. */
  ignoreTitles: string[];
  /** Dead key — file compat with the script's config shape only. */
  stuckQueuedAfterSec?: number;
}

export interface SeatAnnotation {
  kind: 'quiet' | 'waiting-human' | 'dead' | 'recovered';
  quietSec: number;
  detail?: string;
  sinceMs: number;
}

export interface SeatWatchEvent {
  type: 'seat-quiet' | 'seat-waiting-human' | 'seat-unreachable' | 'seat-recovered';
  agentId: string;
  title: string;
  quietSec?: number;
  detail?: string;
  escalate?: string;
  /** Set when the event fired during the silent first tick. */
  baselined?: true;
  atMs: number;
}

/** Narrow roster seam — TerminalRuntime satisfies it structurally. */
export interface SeatRoster {
  list(): AgentInfo[];
}

export interface SeatWatchDeps {
  terminals: SeatRoster;
  claudeDir?: string;
  configPath?: string;
  /** Receives the final #team body (`@chris ` prepend already applied). */
  onAlert?: (body: string) => void;
  /** Extra titles to skip (the watchdog's own durable identity). */
  extraIgnoreTitles?: string[];
  nowMs?: () => number;
  pidAlive?: (terminalPid?: number) => boolean;
}

export interface SeatWatch {
  tick(): void;
  stateFor(agentId: string): SeatAnnotation | null;
  events(): SeatWatchEvent[];
  intervalSec(): number;
}

const CONFIG_DEFAULT_PATH = path.resolve('.novakai-command', 'watchdog.json');
const EVENT_LIMIT = 200;

function defaultConfig(): SeatWatchConfig {
  return {
    intervalSec: 60,
    defaults: { quietAfterSec: 900, escalate: 'team' },
    seats: [],
    ignoreTitles: ['chris'],
    stuckQueuedAfterSec: 600,
  };
}

/** Missing or unreadable config is (re)written with defaults — verbatim from
 * the script, so the on-disk file keeps working for every consumer. */
export function loadWatchdogConfig(configPath: string = CONFIG_DEFAULT_PATH): SeatWatchConfig {
  let loaded: Partial<SeatWatchConfig> | null = null;
  try {
    loaded = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<SeatWatchConfig>;
  } catch {
    loaded = null;
  }
  if (!loaded) writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2));
  return { ...defaultConfig(), ...(loaded ?? {}) };
}

export function boundaryFor(agent: AgentInfo, config: SeatWatchConfig): SeatBoundary {
  const seat = config.seats.find((entry) => entry.agentId === agent.agentId)
    ?? config.seats.find((entry) => entry.title === agent.title);
  return { ...config.defaults, ...(seat ?? {}) };
}

export function transcriptPathFor(agent: AgentInfo, claudeDir: string): string | null {
  if (!agent.sessionId || !agent.projectDir) return null;
  const file = path.join(claudeDir, agent.projectDir, `${agent.sessionId}.jsonl`);
  return existsSync(file) ? file : null;
}

function pidAliveDefault(terminalPid?: number): boolean {
  if (!terminalPid) return false;
  try {
    process.kill(terminalPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readTail(file: string): string | null {
  try {
    const size = statSync(file).size;
    const handle = openSync(file, 'r');
    const byteCount = Math.min(size, 16384);
    const buffer = Buffer.alloc(byteCount);
    readSync(handle, buffer, 0, byteCount, size - byteCount);
    closeSync(handle);
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

function classifyTool(name: string): string {
  if (name === 'AskUserQuestion') return 'a question for a human';
  if (name === 'ExitPlanMode') return 'plan approval';
  return `a possible permission stop (${name})`;
}

interface TranscriptEntry {
  type?: string;
  message?: { content?: unknown };
}

function promptFromEntry(entry: TranscriptEntry): string | null {
  if (entry.type !== 'assistant') return null;
  const content = entry.message?.content;
  const blocks = Array.isArray(content) ? content : [];
  const tool = blocks.find((block) => (block as { type?: string }).type === 'tool_use') as { name?: string } | undefined;
  return tool?.name ? classifyTool(tool.name) : null;
}

/** Best-effort sniff: is the seat sitting on a prompt for a human? The last
 * typed tail entry decides — an assistant tool_use with no tool_result after
 * it never ran (ported verbatim from the script). */
export function pendingPrompt(file: string): string | null {
  const tail = readTail(file);
  if (tail === null) return null;
  const lines = tail.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(lines[index] ?? '') as TranscriptEntry;
    } catch {
      continue;
    }
    if (!entry.type) continue;
    return promptFromEntry(entry);
  }
  return null;
}

interface SeatFlags {
  quietAlerted?: boolean;
  deadAlerted?: boolean;
}

interface WatchContext {
  roster: SeatRoster;
  claudeDir: string;
  configPath: string;
  nowMs: () => number;
  alive: (terminalPid?: number) => boolean;
  onAlert: (body: string) => void;
  extraIgnore: string[];
  flagsByAgent: Map<string, SeatFlags>;
  annotations: Map<string, SeatAnnotation>;
  eventLog: SeatWatchEvent[];
  baselined: boolean;
}

function flagsFor(watch: WatchContext, agentId: string): SeatFlags {
  return watch.flagsByAgent.get(agentId) ?? {};
}

function saveFlags(watch: WatchContext, agentId: string, flags: SeatFlags): void {
  if (Object.keys(flags).length === 0) watch.flagsByAgent.delete(agentId);
  else watch.flagsByAgent.set(agentId, flags);
}

function record(watch: WatchContext, event: Omit<SeatWatchEvent, 'atMs' | 'baselined'>): void {
  const stamped: SeatWatchEvent = { ...event, atMs: watch.nowMs() };
  if (!watch.baselined) stamped.baselined = true;
  watch.eventLog.push(stamped);
  if (watch.eventLog.length > EVENT_LIMIT) watch.eventLog.shift();
}

/** The first tick never posts — it baselines. `@chris ` prepend is the old
 * post() behavior for escalate: 'chris' seats. */
function post(watch: WatchContext, line: string, escalate: string): void {
  if (watch.baselined) watch.onAlert(escalate === 'chris' ? `@chris ${line}` : line);
}

function quietLine(title: string, prompt: string | null, quietSec: number): string {
  const minutes = Math.round(quietSec / 60);
  return prompt
    ? `${title} has been waiting ~${minutes} min on ${prompt} — someone needs to unblock them.`
    : `${title} has gone quiet for ~${minutes} min with nothing pending — worth a look.`;
}

/** Active again: alert-once flags reset so the NEXT episode re-alerts; a
 * recovery event fires only when the seat had been quiet-alerted. */
function recoverSeat(watch: WatchContext, agent: AgentInfo, quietSec: number): void {
  if (flagsFor(watch, agent.agentId).quietAlerted) {
    record(watch, { type: 'seat-recovered', agentId: agent.agentId, title: agent.title, quietSec });
    watch.annotations.set(agent.agentId, { kind: 'recovered', quietSec, sinceMs: watch.nowMs() });
  } else {
    watch.annotations.delete(agent.agentId);
  }
  saveFlags(watch, agent.agentId, {});
}

/** No transcript: Codex seats have none by design — fall back to the pid. */
function checkDeadSeat(watch: WatchContext, agent: AgentInfo, bound: SeatBoundary): void {
  if (watch.alive(agent.terminalPid)) {
    saveFlags(watch, agent.agentId, {});
    watch.annotations.delete(agent.agentId);
    return;
  }
  watch.annotations.set(agent.agentId, { kind: 'dead', quietSec: 0, sinceMs: watch.nowMs() });
  if (flagsFor(watch, agent.agentId).deadAlerted) return;
  record(watch, { type: 'seat-unreachable', agentId: agent.agentId, title: agent.title, escalate: bound.escalate });
  post(watch, `${agent.title} has no transcript and no live process — the seat looks dead despite the roster.`, bound.escalate);
  saveFlags(watch, agent.agentId, { ...flagsFor(watch, agent.agentId), deadAlerted: true });
}

function checkQuietSeat(watch: WatchContext, agent: AgentInfo, bound: SeatBoundary, file: string): void {
  const quietSec = Math.round((watch.nowMs() - statSync(file).mtimeMs) / 1000);
  if (quietSec < bound.quietAfterSec) return recoverSeat(watch, agent, quietSec);
  const prompt = pendingPrompt(file);
  const note: SeatAnnotation = { kind: prompt ? 'waiting-human' : 'quiet', quietSec, sinceMs: watch.nowMs() };
  if (prompt) note.detail = prompt;
  watch.annotations.set(agent.agentId, note);
  if (flagsFor(watch, agent.agentId).quietAlerted) return;
  record(watch, {
    type: prompt ? 'seat-waiting-human' : 'seat-quiet', agentId: agent.agentId,
    title: agent.title, quietSec, detail: prompt ?? undefined, escalate: bound.escalate,
  });
  post(watch, quietLine(agent.title, prompt, quietSec), bound.escalate);
  saveFlags(watch, agent.agentId, { ...flagsFor(watch, agent.agentId), quietAlerted: true });
}

function isSkipped(watch: WatchContext, agent: AgentInfo, config: SeatWatchConfig): boolean {
  if (agent.status === 'exited') return true;
  return [...config.ignoreTitles, ...watch.extraIgnore].includes(agent.title);
}

function checkSeat(watch: WatchContext, agent: AgentInfo, config: SeatWatchConfig): void {
  if (isSkipped(watch, agent, config)) return;
  const bound = boundaryFor(agent, config);
  const file = transcriptPathFor(agent, watch.claudeDir);
  if (file === null) return checkDeadSeat(watch, agent, bound);
  checkQuietSeat(watch, agent, bound, file);
}

/** One pass over the roster. The FIRST tick is a silent baseline: seats
 * already over the boundary get their alert flags set without a post — a
 * backend restart never floods #team with ancient history. */
function tickWatch(watch: WatchContext): void {
  const config = loadWatchdogConfig(watch.configPath);
  for (const agent of watch.roster.list()) checkSeat(watch, agent, config);
  watch.baselined = true;
}

/** F1: the script wrapped every tick in try/catch — restored. A throwing
 * tick (TOCTOU transcript unlink, config ENOSPC) logs and loses ONE pass;
 * the interval driver must never let it kill the backend. */
export function tickSafely(watch: SeatWatch, log: (line: string) => void = console.error): void {
  try {
    watch.tick();
  } catch (error) {
    log(`[seatWatch] tick failed — continuing: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildContext(deps: SeatWatchDeps): WatchContext {
  return {
    roster: deps.terminals,
    claudeDir: deps.claudeDir ?? CLAUDE_DIR,
    configPath: deps.configPath ?? CONFIG_DEFAULT_PATH,
    nowMs: deps.nowMs ?? Date.now,
    alive: deps.pidAlive ?? pidAliveDefault,
    onAlert: deps.onAlert ?? (() => undefined),
    extraIgnore: deps.extraIgnoreTitles ?? [],
    flagsByAgent: new Map(),
    annotations: new Map(),
    eventLog: [],
    baselined: false,
  };
}

export function createSeatWatch(deps: SeatWatchDeps): SeatWatch {
  const watch = buildContext(deps);
  return {
    tick: () => tickWatch(watch),
    stateFor: (agentId: string) => watch.annotations.get(agentId) ?? null,
    events: () => [...watch.eventLog],
    intervalSec: () => loadWatchdogConfig(watch.configPath).intervalSec,
  };
}

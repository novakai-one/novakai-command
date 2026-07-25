// Singleton ws client for persistent agents. Wire protocol frozen in
// docs/persistent-agents.md §5 — DO NOT deviate from the message shapes below.
import type { ProviderId } from '../../../shared/project/schema.js';
import type {
  SessionControlIntent,
  SessionControlReceipt,
} from '../../../shared/sessionControl.js';

export interface AgentInfo {
  agentId: string;
  title: string;
  provider: ProviderId;
  sessionId: string;
  sessionError?: string;
  projectDir: string;
  cwd: string;
  status: 'running' | 'exited';
  terminalPid?: number;
  createdAt: string;
  projectId?: string;
  threadId?: string;
}

export interface SubagentSummary {
  subagentId: string;
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
}

export interface AgentHandlers {
  onReplay: (data: string) => void;
  onData: (data: string) => void;
  onExit: (exitCode: number | null) => void;
}

interface ServerFrame {
  type: string;
  /** Broadcast dialect used by the messaging tunnel: { event, payload }. */
  event?: string;
  payload?: unknown;
  [prop: string]: unknown;
}

interface WatchTarget {
  projectDir: string;
  sessionId: string;
  subscribers: number;
}

const READY_CONNECTING = 0;
const READY_OPEN = 1;

let socket: WebSocket | null = null;
const queue: string[] = [];
const agentHandlers = new Map<string, AgentHandlers>();
const watchedSessions = new Map<string, WatchTarget>();

const agentsChangedListeners: Array<(agents: AgentInfo[]) => void> = [];
const messageEnvelopeListeners: Array<(envelope: unknown) => void> = [];
const roomsChangedListeners: Array<(rooms: unknown) => void> = [];
const messagingV2Listeners: Array<(frame: unknown) => void> = [];
const transcriptEventListeners: Array<(sessionId: string, event: unknown) => void> = [];
const subagentsChangedListeners: Array<(sessionId: string, subagents: SubagentSummary[]) => void> = [];
const subagentEventListeners: Array<(sessionId: string, subagentId: string, event: unknown) => void> = [];
const sessionControlListeners: Array<(receipt: SessionControlReceipt) => void> = [];

let backoffInitialMs = 500;
let backoffMs = 500;
let backoffMaxMs = 8000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// C5 (connection honesty): CLIENT-side status only — the wire protocol is
// frozen; nothing here sends or reshapes a frame. Emits on CHANGE only, so
// reconnect backoff's repeated failed attempts never spam listeners.
export type ConnectionStatus = 'connected' | 'disconnected';
let currentStatus: ConnectionStatus = 'disconnected';
const connectionListeners: Array<(status: ConnectionStatus) => void> = [];

function setConnectionStatus(next: ConnectionStatus): void {
  if (next === currentStatus) return;
  currentStatus = next;
  emitAll(connectionListeners, next);
}

// Test seam: resolved lazily so a fake class installed on globalThis before
// connect() runs is picked up instead of the real browser WebSocket.
function getWebSocketCtor(): typeof WebSocket {
  return globalThis.WebSocket;
}

function socketUrl(): string {
  const host = typeof location !== 'undefined' ? location.host : 'localhost';
  return `ws://${host}/ws`;
}

function emitAll<Args extends unknown[]>(listeners: Array<(...args: Args) => void>, ...args: Args): void {
  for (const listener of listeners) listener(...args);
}

function addListener<Listener>(listeners: Listener[], listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index !== -1) listeners.splice(index, 1);
  };
}

const BROADCAST_HANDLERS: Record<string, (message: ServerFrame) => void> = {
  'agents-changed': message => emitAll(agentsChangedListeners, message.agents as AgentInfo[]),
  'transcript-event': message => emitAll(transcriptEventListeners, message.sessionId as string, message.event),
  'subagents-changed': message =>
    emitAll(subagentsChangedListeners, message.sessionId as string, message.subagents as SubagentSummary[]),
  'subagent-event': message =>
    emitAll(subagentEventListeners, message.sessionId as string, message.subagentId as string, message.event),
  'agent-control-result': message =>
    emitAll(sessionControlListeners, message as unknown as SessionControlReceipt),
};

const AGENT_FRAME_TYPES = new Set(['agent-replay', 'agent-data', 'agent-exit']);

function routeAgentFrame(message: ServerFrame): void {
  const agentId = message.agentId as string;
  const handlers = agentHandlers.get(agentId);
  if (!handlers) return;
  if (message.type === 'agent-replay') return handlers.onReplay(message.data as string);
  if (message.type === 'agent-data') return handlers.onData(message.data as string);
  handlers.onExit((message.exitCode as number | null) ?? null);
}

function routeMessage(message: ServerFrame): void {
  if (AGENT_FRAME_TYPES.has(message.type)) return routeAgentFrame(message);
  // Tunnel envelopes arrive on the event-keyed broadcast dialect ({event,
  // payload}) the server uses for transcript frames — same socket, no type.
  if (message.event === 'message-envelope') return emitAll(messageEnvelopeListeners, message.payload);
  if (message.event === 'messaging-v2') return emitAll(messagingV2Listeners, message.payload);
  if (message.event === 'rooms-changed') {
    return emitAll(roomsChangedListeners, (message.payload as { rooms?: unknown } | undefined)?.rooms);
  }
  const handler = BROADCAST_HANDLERS[message.type];
  if (handler) handler(message);
}

function handleMessage(event: MessageEvent): void {
  const message = JSON.parse(event.data as string) as ServerFrame;
  routeMessage(message);
}

function send(message: Record<string, unknown>): void {
  const frame = JSON.stringify(message);
  if (socket && socket.readyState === READY_OPEN) socket.send(frame);
  else queue.push(frame);
}

function flushQueue(): void {
  const pending = queue.splice(0, queue.length);
  for (const frame of pending) socket?.send(frame);
}

function isOpen(): boolean {
  return !!socket && socket.readyState === READY_OPEN;
}

function resubscribeAll(): void {
  for (const agentId of agentHandlers.keys()) send({ type: 'agent-subscribe', agentId });
  for (const watch of watchedSessions.values()) {
    send({ type: 'watch-session', projectDir: watch.projectDir, sessionId: watch.sessionId });
  }
}

function handleOpen(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  backoffMs = backoffInitialMs;
  flushQueue();
  resubscribeAll();
  setConnectionStatus('connected');
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, backoffMaxMs);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openSocket();
  }, delay);
}

function handleClose(): void {
  socket = null;
  setConnectionStatus('disconnected');
  scheduleReconnect();
}

function openSocket(): void {
  const busy = socket && (socket.readyState === READY_CONNECTING || socket.readyState === READY_OPEN);
  if (busy) return;
  const Ctor = getWebSocketCtor();
  socket = new Ctor(socketUrl());
  socket.onopen = handleOpen;
  socket.onmessage = handleMessage;
  socket.onclose = handleClose;
}

function watchKey(projectDir: string, sessionId: string): string {
  return `${projectDir}::${sessionId}`;
}

export function connect(): void {
  const busy = socket && (socket.readyState === READY_CONNECTING || socket.readyState === READY_OPEN);
  if (!busy) openSocket();
}

// Sends only when the socket is already open. When not open, the frame is
// deliberately NOT queued: resubscribeAll() re-sends it on the next open, and
// queueing here too would double-send it (Fix: reconnect double replay).
export function subscribeAgent(agentId: string, handlers: AgentHandlers): void {
  agentHandlers.set(agentId, handlers);
  if (isOpen()) send({ type: 'agent-subscribe', agentId });
}

export function unsubscribeAgent(agentId: string): void {
  agentHandlers.delete(agentId); // local only — no server frame per spec §6
}

export function sendInput(agentId: string, data: string): void {
  send({ type: 'agent-input', agentId, data });
}

export function sendResize(agentId: string, cols: number, rows: number): void {
  send({ type: 'agent-resize', agentId, cols, rows });
}

/** Live controls are never queued: a stale model switch after reconnect is worse than rejection. */
export function sendAgentControl(commandId: string, agentId: string, intent: SessionControlIntent): boolean {
  if (!isOpen()) return false;
  send({ type: 'agent-control', commandId, agentId, intent });
  return true;
}

// Same not-queued rule as subscribeAgent: resubscribeAll() re-sends watch-session
// for every watched session on open, so queueing it here too would double-send it.
export function watchSession(projectDir: string, sessionId: string): void {
  const watchId = watchKey(projectDir, sessionId);
  const current = watchedSessions.get(watchId);
  if (current) {
    current.subscribers += 1;
    return;
  }
  watchedSessions.set(watchId, { projectDir, sessionId, subscribers: 1 });
  if (isOpen()) send({ type: 'watch-session', projectDir, sessionId });
}

// Same not-queued rule: removing from watchedSessions alone is correct when the
// socket is closed, since resubscribeAll() only re-sends what's still in the map.
export function unwatchSession(projectDir: string, sessionId: string): void {
  const watchId = watchKey(projectDir, sessionId);
  const current = watchedSessions.get(watchId);
  if (!current) return;
  if (current.subscribers > 1) {
    current.subscribers -= 1;
    return;
  }
  watchedSessions.delete(watchId);
  if (isOpen()) send({ type: 'unwatch-session', projectDir, sessionId });
}

export function onAgentsChanged(listener: (agents: AgentInfo[]) => void): () => void {
  return addListener(agentsChangedListeners, listener);
}

/** Tunnel feed: every appended message envelope (sends AND status amendments). */
export function onMessageEnvelope(listener: (envelope: unknown) => void): () => void {
  return addListener(messageEnvelopeListeners, listener);
}

/** Tunnel rooms: the full room roster snapshot on every rooms.jsonl append. */
export function onRoomsChanged(listener: (rooms: unknown) => void): () => void {
  return addListener(roomsChangedListeners, listener);
}

/** N4 (D-N4-1): capability frames forwarded by the per-connection
 * messaging-v2 subscription (payload = the SubscriptionMessage verbatim). */
export function onMessagingV2(listener: (frame: unknown) => void): () => void {
  return addListener(messagingV2Listeners, listener);
}

/** N4 (D-N4-1): (re)open the per-connection subscription, resuming from the
 * client's persisted cursor when supplied. */
export function sendMessagingV2Sub(since?: string): void {
  send({ type: 'messaging-v2-sub', ...(since !== undefined ? { since } : {}) });
}

export function onTranscriptEvent(listener: (sessionId: string, event: unknown) => void): () => void {
  return addListener(transcriptEventListeners, listener);
}

export function onSubagentsChanged(
  listener: (sessionId: string, subagents: SubagentSummary[]) => void
): () => void {
  return addListener(subagentsChangedListeners, listener);
}

export function onSubagentEvent(
  listener: (sessionId: string, subagentId: string, event: unknown) => void
): () => void {
  return addListener(subagentEventListeners, listener);
}

/** Current client↔backend ws status — 'disconnected' until the first open. */
export function connectionStatus(): ConnectionStatus {
  return currentStatus;
}

/** Fires on every connected↔disconnected TRANSITION (never on retries while
 * already down). Reconnect itself stays the existing backoff loop — this is
 * the missing trigger for refetch-on-reopen, nothing more. */
export function onConnectionChanged(listener: (status: ConnectionStatus) => void): () => void {
  return addListener(connectionListeners, listener);
}

export function onSessionControlResult(
  listener: (receipt: SessionControlReceipt) => void,
): () => void {
  return addListener(sessionControlListeners, listener);
}

// Test-only seam: shrinks the backoff window so reconnect tests don't sleep 500ms+.
export function setBackoffForTest(initialMs: number, maxMs: number): void {
  backoffInitialMs = initialMs;
  backoffMs = initialMs;
  backoffMaxMs = maxMs;
}

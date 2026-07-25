/**
 * messagingV2 live feed hook (slice N4, D-N4-1/D-N4-2): the React half of
 * the data plane — initial REST load (threads + trailing windows), then
 * ZERO REST polls: live frames ride the per-connection forwarded
 * subscription, resume persists to localStorage, `ended` retries with
 * exponential backoff (a dependency-lost end before the first success never
 * refetches), and a failed load is a load ERROR (banner), never a fake
 * empty inbox. Presence UI lives with PeopleHub (D-N4-5) — this lib carries
 * no presence plumbing. Split from ../index.ts for the ratchet.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  connect,
  connectionStatus,
  onConnectionChanged,
  onMessagingV2,
  sendMessagingV2Sub,
  type AgentInfo,
  type ConnectionStatus,
} from '../../agentSocket/index.js';
import {
  advanceCursor,
  applyDelivery,
  fetchThreadMessages,
  fetchThreads,
  loadCursor,
  mergeFeed,
  saveCursor,
  translateMessage,
  upsertRow,
  CHRIS,
} from '../index.js';
import type {
  CapabilityMessage,
  CapabilityThread,
  MessageRow,
} from '../index.js';

export interface MessagingFeed {
  feed: MessageRow[];
  threads: CapabilityThread[];
  feedLoaded: boolean;
  /** F16: the last load FAILED — the view shows a degraded banner, never a
   * fake empty inbox. Clears on the next successful load. */
  loadError: boolean;
  connection: ConnectionStatus;
  /** Optimistic send: 'queued' until the committed echo settles the row. */
  send(input: { to: string; body: string; interrupt?: boolean }): Promise<boolean>;
}

interface FeedState {
  threads: Map<string, CapabilityThread>;
  lastSeen: number;
  localCounter: number;
  /** F5: true after the first successful subscribe; retries back off until then. */
  everLive: boolean;
  retryCount: number;
}

interface FrameMessage {
  sequence?: number;
  message?: CapabilityMessage;
  delivery?: { messageId: string; state: string };
}

interface LiveFrame {
  kind: 'started' | 'event' | 'ended';
  sequence?: number;
  event?: FrameMessage;
  reason?: string;
}

function maxSequence(messages: CapabilityMessage[]): number {
  return messages.reduce((highest, message) => Math.max(highest, message.sequence ?? 0), 0);
}

/** Fresh thread list into state (F12's unknown-thread path shares it). */
async function refreshThreads(state: FeedState): Promise<boolean> {
  const threads = await fetchThreads();
  if (threads === null) return false;
  state.threads = new Map(threads.map((thread) => [thread.id, thread]));
  return true;
}

async function loadAll(state: FeedState, agents: AgentInfo[]): Promise<{ rows: MessageRow[] } | null> {
  // F16: a failed threads read is a LOAD ERROR — never fold it into an
  // empty inbox (the rows already on screen are worth more than a lie).
  if (!(await refreshThreads(state))) return null;
  const threads = [...state.threads.values()];
  const pages = await Promise.all(threads.map((thread) => fetchThreadMessages(thread.id)));
  const rows = pages.flat().map((message) => translateMessage(message, state.threads, agents));
  state.lastSeen = Math.max(state.lastSeen, maxSequence(pages.flat()));
  return { rows };
}

/** F8a (audit): the cursor advances on ALL sequenced frames — messages AND
 * deliveries — so a replay can never skip a DeliveryUpdated fact. */
function frameSequence(frame: LiveFrame): number | undefined {
  return frame.event?.message?.sequence
    ?? (frame.event?.delivery !== undefined ? frame.event.sequence : undefined)
    ?? frame.sequence;
}

function applyMessageFrame(
  state: FeedState,
  frame: LiveFrame,
  agents: AgentInfo[],
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
): void {
  const message = frame.event?.message;
  if (message === undefined) return;
  if (!state.threads.has(message.threadId)) {
    // F12 (audit): a commit for a thread we don't know — refetch threads,
    // THEN translate. It never files under a raw threadId lane.
    void refreshThreads(state).then(() => {
      setThreads([...state.threads.values()]);
      setFeed((current) => upsertRow(current, translateMessage(message, state.threads, agents)));
    });
    return;
  }
  setFeed((current) => upsertRow(current, translateMessage(message, state.threads, agents)));
}

function applyDeliveryFrame(
  frame: LiveFrame,
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
): void {
  if (frame.event?.delivery === undefined) return;
  setFeed((current) => applyDelivery(current, frame.event?.delivery as { messageId: string; state: string }));
}

export function applyFrame(
  state: FeedState,
  frame: LiveFrame,
  agents: AgentInfo[],
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
): void {
  if (frame.kind !== 'event' || frame.event === undefined) return;
  const sequence = frameSequence(frame);
  const next = advanceCursor(state.lastSeen, sequence);
  if (next === state.lastSeen && (sequence ?? 0) > 0) return; // at-least-once dupe
  state.lastSeen = next;
  if (sequence !== undefined) saveCursor(next);
  if (frame.event.message !== undefined) {
    applyMessageFrame(state, frame, agents, setFeed, setThreads);
    return;
  }
  applyDeliveryFrame(frame, setFeed);
  // PresenceChanged frames are intentionally ignored — PeopleHub owns
  // presence UI (D-N4-5, F11).
}

async function postUserSend(input: { to: string; body: string; interrupt?: boolean }): Promise<{ messageId: string; threadId: string } | null> {
  try {
    const response = await fetch('/api/messaging/v2/user/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ 'to': input.to, body: input.body, interrupt: input.interrupt === true }),
    });
    if (!response.ok) return null;
    return (await response.json()) as { messageId: string; threadId: string };
  } catch {
    return null;
  }
}

function optimisticRow(localId: string, input: { to: string; body: string; interrupt?: boolean }): MessageRow {
  // The optimistic row lands in the lane the echo will confirm (agent
  // name → dm lane; room targets are already lane-shaped).
  const lane = input.to.startsWith('#') ? input.to : `dm:${input.to}`;
  return {
    id: localId, from: CHRIS, 'to': lane, delivery: input.interrupt === true ? 'interrupt' : 'normal',
    body: input.body, createdAt: new Date().toISOString(), status: 'queued',
  };
}

/** The optimistic-send factory (kept out of the hook body for the ratchet). */
export function makeSend(
  state: { current: FeedState },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
): MessagingFeed['send'] {
  return async (input) => {
    state.current.localCounter += 1;
    const localId = `local_${Date.now()}_${state.current.localCounter}`;
    setFeed((current) => upsertRow(current, optimisticRow(localId, input)));
    const result = await postUserSend(input);
    if (result === null) {
      // F4 (audit): a failed POST is an honest TERMINAL failure (it feeds the
      // amber flow) — never a permanent 'queued' ghost.
      setFeed((current) => current.map((entry) => (entry.id === localId ? { ...entry, status: 'failed' as const } : entry)));
      return false;
    }
    setFeed((current) => current.map((entry) => (entry.id === localId ? { ...entry, id: result.messageId, threadId: result.threadId } : entry)));
    return true;
  };
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

type ScheduleFn = (task: () => void, delayMs: number) => void;
const defaultSchedule: ScheduleFn = (task, delayMs) => {
  setTimeout(task, delayMs);
};

/** The frame dispatcher for the live wire. F5 (audit): `ended` retries with
 * exponential backoff (500 ms → 8 s, agentSocket's rhythm), and a
 * dependency-lost end BEFORE the first successful subscribe never refetches
 * — the capability is down; only the resubscribe retries. */
export function frameHandler(
  state: { current: FeedState },
  agentsRef: { current: AgentInfo[] },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
  reload: () => Promise<void>,
  subscribeLive: () => void,
  schedule: ScheduleFn = defaultSchedule,
): (frame: LiveFrame) => void {
  return (frame) => {
    if (frame.kind === 'started') return markStarted(state);
    if (frame.kind !== 'ended') {
      applyFrame(state.current, frame, agentsRef.current, setFeed, setThreads);
      return;
    }
    handleEnded(state, frame, reload, subscribeLive, schedule);
  };
}

function markStarted(state: { current: FeedState }): void {
  state.current.everLive = true;
  state.current.retryCount = 0;
}

function handleEnded(
  state: { current: FeedState },
  frame: LiveFrame,
  reload: () => Promise<void>,
  subscribeLive: () => void,
  schedule: ScheduleFn,
): void {
  const retryCount = state.current.retryCount ?? 0;
  state.current.retryCount = retryCount + 1;
  const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** retryCount, BACKOFF_MAX_MS);
  if (frame.reason === 'dependency-lost' && state.current.everLive !== true) {
    console.warn(`[messaging-v2] capability unavailable — resubscribing in ${backoffMs}ms (no refetch)`);
    schedule(() => subscribeLive(), backoffMs);
    return;
  }
  console.warn(`[messaging-v2] subscription ended (${frame.reason ?? 'unknown'}) — refetching from the tip in ${backoffMs}ms`);
  schedule(() => {
    void reload().then(subscribeLive);
  }, backoffMs);
}

/** The reload factory: one REST load → feed + threads state. F7 (audit):
 * history folds UNDER live rows by id (live wins) — a frame landing
 * mid-reload is never wholesale-replaced away. F16 (audit): a failed load
 * is a load error (the banner shows), never a fake empty inbox. */
export function makeReload(
  state: { current: FeedState },
  agentsRef: { current: AgentInfo[] },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
  setFeedLoaded: (loaded: boolean) => void,
  setLoadError?: (flag: boolean) => void,
): () => Promise<void> {
  return async () => {
    const loaded = await loadAll(state.current, agentsRef.current);
    if (loaded === null) {
      setLoadError?.(true);
      setFeedLoaded(true); // never stuck on the spinner — the banner carries the truth
      return;
    }
    applyLoaded(state, loaded.rows, setFeed, setThreads, setFeedLoaded, setLoadError);
  };
}

function applyLoaded(
  state: { current: FeedState },
  rows: MessageRow[],
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
  setFeedLoaded: (loaded: boolean) => void,
  setLoadError?: (flag: boolean) => void,
): void {
  setLoadError?.(false);
  setFeed((current) => mergeFeed(rows, current));
  setThreads([...state.current.threads.values()]);
  setFeedLoaded(true);
}

/** The resubscribe factory: resume from the live cursor or the persisted one. */
function makeSubscribeLive(state: { current: FeedState }): () => void {
  return () => {
    const cursor = state.current.lastSeen > 0 ? `s_${state.current.lastSeen}` : loadCursor();
    sendMessagingV2Sub(cursor);
  };
}

export function useMessagingFeed(agents: AgentInfo[]): MessagingFeed {
  const [feed, setFeed] = useState<MessageRow[]>([]);
  const [threads, setThreads] = useState<CapabilityThread[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>(() => connectionStatus());
  const state = useRef<FeedState>({ threads: new Map(), lastSeen: 0, localCounter: 0, everLive: false, retryCount: 0 });
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const reload = useCallback(makeReload(state, agentsRef, setFeed, setThreads, setFeedLoaded, setLoadError), []);
  const subscribeLive = useCallback(makeSubscribeLive(state), []);
  useLiveWire(state, agentsRef, setFeed, setThreads, setConnection, reload, subscribeLive);
  const send = useCallback(makeSend(state, setFeed), []);
  return { feed, threads, feedLoaded, loadError, connection, send };
}

interface LiveWireRefs {
  state: { current: FeedState };
  agentsRef: { current: AgentInfo[] };
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void;
  setThreads: (threads: CapabilityThread[]) => void;
  setConnection: (status: ConnectionStatus) => void;
  reload: () => Promise<void>;
  subscribeLive: () => void;
}

/** The effect body, extracted: connect, load, listen, clean up. F1 (audit):
 * a feed mounted while the socket is ALREADY open subscribes immediately —
 * onConnectionChanged only fires on transitions. */
export function wireLive(refs: LiveWireRefs): () => void {
  const handleFrame = frameHandler(refs.state, refs.agentsRef, refs.setFeed, refs.setThreads, refs.reload, refs.subscribeLive);
  connect();
  if (connectionStatus() === 'connected') refs.subscribeLive();
  void refs.reload();
  const offFrames = onMessagingV2((frame) => handleFrame(frame as LiveFrame));
  const offConnection = onConnectionChanged((status) => {
    refs.setConnection(status);
    if (status === 'connected') refs.subscribeLive();
  });
  return () => {
    offFrames();
    offConnection();
  };
}

function useLiveWire(
  state: { current: FeedState },
  agentsRef: { current: AgentInfo[] },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
  setConnection: (status: ConnectionStatus) => void,
  reload: () => Promise<void>,
  subscribeLive: () => void,
): void {
  useEffect(
    () => wireLive({ state, agentsRef, setFeed, setThreads, setConnection, reload, subscribeLive }),
    [reload, subscribeLive, state, agentsRef, setFeed, setThreads, setConnection],
  );
}

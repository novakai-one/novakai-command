/**
 * messagingV2 live feed hook (slice N4, D-N4-1/D-N4-2): the React half of
 * the data plane — initial REST load (threads + trailing windows +
 * presence), then ZERO REST polls: live frames ride the per-connection
 * forwarded subscription, resume persists to localStorage, `ended` does a
 * full refetch + resubscribe from the tip (logged). Split from
 * ../index.ts for the directory ratchet; the translator lives there.
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
  fetchPresence,
  fetchThreadMessages,
  fetchThreads,
  loadCursor,
  saveCursor,
  translateMessage,
  upsertRow,
  CHRIS,
} from '../index.js';
import type {
  CapabilityMessage,
  CapabilityThread,
  MessageRow,
  PresenceMap,
} from '../index.js';

export interface MessagingFeed {
  feed: MessageRow[];
  threads: CapabilityThread[];
  presence: PresenceMap;
  feedLoaded: boolean;
  connection: ConnectionStatus;
  /** Optimistic send: 'queued' until the committed echo settles the row. */
  send(input: { to: string; body: string; interrupt?: boolean }): Promise<boolean>;
}

interface FeedState {
  threads: Map<string, CapabilityThread>;
  lastSeen: number;
  localCounter: number;
}

interface FrameMessage {
  sequence?: number;
  message?: CapabilityMessage;
  delivery?: { messageId: string; state: string };
  presence?: { personId: string };
  change?: 'opened' | 'closed';
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

async function loadAll(state: FeedState, agents: AgentInfo[]): Promise<{ rows: MessageRow[]; presence: PresenceMap }> {
  const threads = await fetchThreads();
  state.threads = new Map(threads.map((thread) => [thread.id, thread]));
  const pages = await Promise.all(threads.map((thread) => fetchThreadMessages(thread.id)));
  const rows = pages.flat().map((message) => translateMessage(message, state.threads, agents));
  state.lastSeen = Math.max(state.lastSeen, maxSequence(pages.flat()));
  const presence: PresenceMap = {};
  for (const entry of await fetchPresence()) presence[entry.personId] = 'open';
  return { rows, presence };
}

function applyMessageFrame(
  state: FeedState,
  frame: LiveFrame,
  agents: AgentInfo[],
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
): void {
  const message = frame.event?.message;
  if (message === undefined) return;
  const next = advanceCursor(state.lastSeen, message.sequence ?? frame.sequence);
  if (next === state.lastSeen && (message.sequence ?? 0) > 0) return; // at-least-once dupe
  state.lastSeen = next;
  saveCursor(next);
  setFeed((current) => upsertRow(current, translateMessage(message, state.threads, agents)));
}

function applyPresenceFrame(
  frame: LiveFrame,
  setPresence: (updater: (current: PresenceMap) => PresenceMap) => void,
): void {
  if (frame.event?.presence === undefined) return;
  const personId = frame.event.presence.personId;
  const change = frame.event.change ?? 'opened';
  setPresence((current) => ({ ...current, [personId]: change === 'opened' ? 'open' : 'closed' }));
}

function applyFrame(
  state: FeedState,
  frame: LiveFrame,
  agents: AgentInfo[],
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setPresence: (updater: (current: PresenceMap) => PresenceMap) => void,
): void {
  if (frame.kind !== 'event' || frame.event === undefined) return;
  if (frame.event.message !== undefined) {
    applyMessageFrame(state, frame, agents, setFeed);
    return;
  }
  if (frame.event.delivery !== undefined) {
    setFeed((current) => applyDelivery(current, frame.event?.delivery as { messageId: string; state: string }));
    return;
  }
  applyPresenceFrame(frame, setPresence);
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
function makeSend(
  state: { current: FeedState },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
): MessagingFeed['send'] {
  return async (input) => {
    state.current.localCounter += 1;
    const localId = `local_${Date.now()}_${state.current.localCounter}`;
    setFeed((current) => upsertRow(current, optimisticRow(localId, input)));
    const result = await postUserSend(input);
    if (result === null) return false;
    setFeed((current) => current.map((entry) => (entry.id === localId ? { ...entry, id: result.messageId, threadId: result.threadId } : entry)));
    return true;
  };
}

/** The frame dispatcher for the live wire (ended → refetch + resubscribe). */
function frameHandler(
  state: { current: FeedState },
  agentsRef: { current: AgentInfo[] },
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void,
  setPresence: (updater: (current: PresenceMap) => PresenceMap) => void,
  reload: () => Promise<void>,
  subscribeLive: () => void,
): (frame: LiveFrame) => void {
  return (frame) => {
    if (frame.kind === 'ended') {
      console.warn(`[messaging-v2] subscription ended (${frame.reason ?? 'unknown'}) — refetching from the tip`);
      void reload().then(subscribeLive);
      return;
    }
    applyFrame(state.current, frame, agentsRef.current, setFeed, setPresence);
  };
}

/** The reload factory: one REST load → feed + threads + presence state. */
function makeReload(
  state: { current: FeedState },
  agentsRef: { current: AgentInfo[] },
  setFeed: (rows: MessageRow[]) => void,
  setThreads: (threads: CapabilityThread[]) => void,
  setPresence: (map: PresenceMap) => void,
  setFeedLoaded: (loaded: boolean) => void,
): () => Promise<void> {
  return async () => {
    const loaded = await loadAll(state.current, agentsRef.current);
    setFeed(loaded.rows);
    setThreads([...state.current.threads.values()]);
    setPresence(loaded.presence);
    setFeedLoaded(true);
  };
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
  const [presence, setPresence] = useState<PresenceMap>({});
  const [feedLoaded, setFeedLoaded] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>(() => connectionStatus());
  const state = useRef<FeedState>({ threads: new Map(), lastSeen: 0, localCounter: 0 });
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const reload = useCallback(makeReload(state, agentsRef, setFeed, setThreads, setPresence, setFeedLoaded), []);
  const subscribeLive = useCallback(makeSubscribeLive(state), []);
  useLiveWire(state, agentsRef, setFeed, setPresence, setConnection, reload, subscribeLive);
  const send = useCallback(makeSend(state, setFeed), []);
  return { feed, threads, presence, feedLoaded, connection, send };
}

interface LiveWireRefs {
  state: { current: FeedState };
  agentsRef: { current: AgentInfo[] };
  setFeed: (updater: (current: MessageRow[]) => MessageRow[]) => void;
  setPresence: (updater: (current: PresenceMap) => PresenceMap) => void;
  setConnection: (status: ConnectionStatus) => void;
  reload: () => Promise<void>;
  subscribeLive: () => void;
}

/** The effect body, extracted: connect, load, listen, clean up. */
function wireLive(refs: LiveWireRefs): () => void {
  const handleFrame = frameHandler(refs.state, refs.agentsRef, refs.setFeed, refs.setPresence, refs.reload, refs.subscribeLive);
  connect();
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
  setPresence: (updater: (current: PresenceMap) => PresenceMap) => void,
  setConnection: (status: ConnectionStatus) => void,
  reload: () => Promise<void>,
  subscribeLive: () => void,
): void {
  useEffect(
    () => wireLive({ state, agentsRef, setFeed, setPresence, setConnection, reload, subscribeLive }),
    [reload, subscribeLive, state, agentsRef, setFeed, setPresence, setConnection],
  );
}

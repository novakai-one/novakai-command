// shell/ui/screens/messaging/useBenchData.ts — THE projection: ShellServices →
// MessagesDesignData. The only module that maps contract data (conversations,
// messages, agents, presence) into the object-graph shapes every Messages
// design consumes (M1-06: one data path, many designs). The graph is rebuilt
// from service data on each refresh and never fetches or stores (M1-02).
//
// Send correctness lives at this seam (M1-05): optimistic append, socket-echo
// dedupe and stale-load merge reuse the proven messageList.ts helpers — moved
// call-site, not rewritten logic.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentDefView, ChatMessage, ConversationSummary, ShellServices,
} from '../../../contract/index.js';
import { PresenceTracker } from '../../../contract/index.js';
import type { MessagesDesignData } from '../../messages-designs/contract';
import type { ObjectRecord } from '../../messages-designs/contract';
import { buildGraph } from '../../messages-designs/graph';
import { appendDedup, reconcileLoadedMessages, settleOptimisticMessage } from './messageList.js';

/** The signed-in person at this seam. The server maps the human's personId to
 * the literal 'me' on every ChatMessage it serves (server/core/methods.ts), so
 * this IS the wire contract, not a guess. */
export const SELF_ID = 'me';
const SELF_TITLE = 'Chris';

type SendOutcome = Awaited<ReturnType<ShellServices['sendMessage']>>;

export interface BenchDataApi {
  data: MessagesDesignData;
  /** True once the first conversations+messages load has landed. The Bench
   * reconciles its restored session against the model on mount, so mounting it
   * before real data arrives would strip every restored open thread/frame —
   * the sandbox mounted against synchronous fixtures; this flag restores that
   * data-at-mount contract for async services. */
  ready: boolean;
  conversations: readonly ConversationSummary[];
  /** Draw one message immediately (optimistic send / visible slash refusal). */
  appendLocal(message: ChatMessage): void;
  /** Settle an optimistic row against the send outcome (same id in = one row out). */
  settleLocal(conversationId: string, optimisticId: string, outcome: SendOutcome): void;
  /** Draw one conversation immediately (optimistic spawn, D31); the server echo
   * with the same client-minted id replaces it on the next refresh. */
  appendLocalConversation(summary: ConversationSummary): void;
  /** Look up a loaded/local message (the resend affordance needs its opId). */
  findMessage(conversationId: string, messageId: string): ChatMessage | undefined;
  /** Newest committed message id, or undefined (S3 read-cursor target). */
  lastMessageId(conversationId: string): string | undefined;
  refreshConversations(): Promise<void>;
}

function threadRecord(c: ConversationSummary): ObjectRecord {
  return {
    id: c.id,
    kind: 'thread',
    title: c.title,
    createdAt: c.lastActivityAt,
    fields: {
      archived: c.archived,
      pinned: c.pinned,
      kind: c.kind,
      ...(c.agentId ? { agentId: c.agentId } : {}),
    },
    refs: c.agentId ? [{ kind: 'agent', value: c.agentId }] : [],
  };
}

function messageRecord(m: ChatMessage, conversationAgentId?: string): ObjectRecord {
  // S2: the wire says an agent reply's sender is its messaging PERSON, an id
  // the graph never carries. The conversation's agent IS that participant's
  // graph identity, so a non-self sender in an agent conversation renders as
  // the agent — never as "Unknown sender".
  const senderId = m.senderId !== SELF_ID && conversationAgentId ? conversationAgentId : m.senderId;
  return {
    id: m.id,
    kind: 'message',
    title: m.text,
    createdAt: m.createdAt,
    fields: {
      threadId: m.conversationId,
      senderId,
      body: m.text,
      createdAt: m.createdAt,
      ...(m.pending ? { pending: true } : {}),
      ...(m.failed ? { failed: m.failed } : {}),
      ...(m.clientOpId ? { clientOpId: m.clientOpId } : {}),
    },
    refs: [],
  };
}

function agentRecord(a: AgentDefView, tracker: PresenceTracker): ObjectRecord {
  const presence = tracker.get(a.id);
  return {
    id: a.id,
    kind: 'agent',
    title: a.displayName,
    createdAt: '',
    fields: {
      provider: a.provider,
      model: a.model,
      status: presence.state,
      composing: presence.state === 'active',
    },
    refs: [],
  };
}

/** Agents referenced by conversations but absent from the agent list still get
 * a graph record, so participant chips render their id instead of vanishing. */
function placeholderAgent(id: string, tracker: PresenceTracker): ObjectRecord {
  const presence = tracker.get(id);
  return {
    id,
    kind: 'agent',
    title: id,
    createdAt: '',
    fields: { status: presence.state, composing: presence.state === 'active' },
    refs: [],
  };
}

/** S3 (M3-01): the unread DERIVATION — cursor + loaded messages, no stored
 * counts. No cursor means never marked read: every non-self message is
 * honestly unread. */
export function unreadMessages(
  convo: ConversationSummary, loaded: readonly ChatMessage[],
): ChatMessage[] {
  const cutoff = convo.lastReadMessageId
    ? loaded.findIndex((m) => m.id === convo.lastReadMessageId)
    : -1;
  return loaded.slice(cutoff + 1).filter((m) => m.senderId !== SELF_ID && !m.pending && !m.failed);
}

/** The ported Bench draws a thread's badge from notification records related
 * via 'notified' (bench-projection). Mint one per unread message — 1:1 mirrors
 * of persisted facts, never invented (M1-04). */
function unreadNotificationRecords(
  convo: ConversationSummary, loaded: readonly ChatMessage[],
): ObjectRecord[] {
  return unreadMessages(convo, loaded).map((m) => ({
    id: `notif_unread_${m.id}`,
    kind: 'notification',
    title: m.text,
    createdAt: m.createdAt,
    fields: { status: 'unread', messageId: m.id },
    refs: [{ kind: 'thread', value: convo.id }],
  }));
}

export function useBenchData(props: {
  services: ShellServices;
  tracker: PresenceTracker;
  selectedId: string | null;
}): BenchDataApi {
  const { services, tracker } = props;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  // D31: optimistic conversations live here until the server echo (same id)
  // lands in a refresh; a failed spawn leaves its card explained by a failed
  // row and gone on reload (nothing exists server-side).
  const [pendingConvos, setPendingConvos] = useState<ConversationSummary[]>([]);
  const [messagesByConvo, setMessagesByConvo] = useState<ReadonlyMap<string, ChatMessage[]>>(new Map());
  const [agents, setAgents] = useState<AgentDefView[]>([]);
  const [presenceTick, setPresenceTick] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => tracker.subscribe(() => setPresenceTick((n) => n + 1)), [tracker]);

  const loadMessagesFor = useCallback(async (convoIds: readonly string[]) => {
    const loadedEntries = await Promise.all(convoIds.map(async (id) => {
      const loaded = await services.getMessages(id).catch(() => [] as ChatMessage[]);
      return [id, loaded] as const;
    }));
    setMessagesByConvo((current) => {
      const next = new Map(current);
      for (const [id, loaded] of loadedEntries) {
        // A slow load must never erase newer optimistic/live messages (M1-05).
        next.set(id, reconcileLoadedMessages(current.get(id) ?? [], loaded, id));
      }
      return next;
    });
  }, [services]);

  const refreshConversations = useCallback(async () => {
    const list = await services.listConversations();
    setConversations(list);
    setPendingConvos((prev) => prev.filter((p) => !list.some((c) => c.id === p.id)));
    // S2: a spawn defines agents mid-session — refresh defs with conversations
    // so a new participant renders its displayName, never a raw id.
    void services.agents?.listAgents().then(setAgents).catch(() => {});
    await loadMessagesFor(list.map((c) => c.id));
    setReady(true);
  }, [services, loadMessagesFor]);

  const allConversations = useMemo(() => {
    const known = new Set(conversations.map((c) => c.id));
    return [...conversations, ...pendingConvos.filter((p) => !known.has(p.id))];
  }, [conversations, pendingConvos]);

  useEffect(() => { void refreshConversations(); }, [refreshConversations]);
  useEffect(() => {
    void services.agents?.listAgents().then(setAgents).catch(() => {});
  }, [services]);

  useEffect(() => services.subscribe({
    onMessage: (m) => {
      setMessagesByConvo((current) => {
        const next = new Map(current);
        next.set(m.conversationId, appendDedup(current.get(m.conversationId) ?? [], m));
        return next;
      });
    },
    onConversation: () => { void refreshConversations(); },
  }), [services, refreshConversations]);

  const appendLocalConversation = useCallback((summary: ConversationSummary) => {
    setPendingConvos((prev) => (prev.some((c) => c.id === summary.id) ? prev : [...prev, summary]));
  }, []);

  const appendLocal = useCallback((message: ChatMessage) => {
    setMessagesByConvo((current) => {
      const next = new Map(current);
      next.set(message.conversationId, appendDedup(current.get(message.conversationId) ?? [], message));
      return next;
    });
  }, []);

  const settleLocal = useCallback((conversationId: string, optimisticId: string, outcome: SendOutcome) => {
    setMessagesByConvo((current) => {
      const next = new Map(current);
      next.set(conversationId, settleOptimisticMessage(current.get(conversationId) ?? [], optimisticId, outcome));
      return next;
    });
  }, []);

  const data = useMemo<MessagesDesignData>(() => {
    const threads = allConversations.map(threadRecord);
    const agentByConvo = new Map(allConversations.map((c) => [c.id, c.agentId]));
    const messages = [...messagesByConvo.values()].flat()
      .map((m) => messageRecord(m, agentByConvo.get(m.conversationId)));
    const knownAgentIds = new Set(agents.map((a) => a.id));
    const referencedAgentIds = new Set(
      allConversations.map((c) => c.agentId).filter((id): id is string => Boolean(id)),
    );
    const agentRecords = [
      ...agents.filter((a) => a.status !== 'archived').map((a) => agentRecord(a, tracker)),
      ...[...referencedAgentIds].filter((id) => !knownAgentIds.has(id))
        .map((id) => placeholderAgent(id, tracker)),
    ];
    const self: ObjectRecord = {
      id: SELF_ID, kind: 'principal', title: SELF_TITLE, createdAt: '', fields: {}, refs: [],
    };
    const unreadNotifs = allConversations.flatMap((c) => (
      unreadNotificationRecords(c, messagesByConvo.get(c.id) ?? [])
    ));
    const graph = buildGraph([self, ...agentRecords, ...threads, ...messages, ...unreadNotifs]);
    // S2 (D32): the draft picker offers existing agents not already holding a
    // live conversation (one person per agent = one thread, D22/D30), plus one
    // "new agent" pseudo-entry per provider the host can actually spawn on.
    // Pseudo-entries feed ONLY this picker list — never the graph (M1-04).
    const conversedAgentIds = new Set(
      allConversations.filter((c) => !c.archived && c.agentId).map((c) => c.agentId),
    );
    const spawnable = services.providerAvailability ?? {};
    const liveAgents: ObjectRecord[] = [
      ...agentRecords.filter((a) => !conversedAgentIds.has(a.id)),
      ...(['kimi', 'claude', 'codex', 'mock'] as const)
        .filter((provider) => spawnable[provider])
        .map((provider): ObjectRecord => ({
          id: `new:${provider}`,
          kind: 'agent',
          title: `New ${provider} agent`,
          createdAt: '',
          fields: { provider },
          refs: [],
        })),
    ];
    return {
      graph,
      selfId: SELF_ID,
      threads,
      liveAgents,
      selected: props.selectedId ? graph.get(props.selectedId) ?? null : null,
      attentionSubjectId: null,
    };
    // presenceTick: agent status/composing fields are derived from the tracker,
    // so a presence event must rebuild the records even though it is not state.
  }, [allConversations, messagesByConvo, agents, tracker, services, props.selectedId, presenceTick]);

  const findMessage = useCallback((conversationId: string, messageId: string) => (
    messagesByConvo.get(conversationId)?.find((m) => m.id === messageId)
  ), [messagesByConvo]);

  // S3: the newest COMMITTED message — the cursor never advances onto a
  // pending/failed local row (those ids are not truth).
  const lastMessageId = useCallback((conversationId: string) => (
    [...(messagesByConvo.get(conversationId) ?? [])]
      .filter((m) => !m.pending && !m.failed)
      .at(-1)?.id
  ), [messagesByConvo]);

  return {
    data, ready, conversations: allConversations,
    appendLocal, settleLocal, appendLocalConversation, findMessage, lastMessageId,
    refreshConversations,
  };
}

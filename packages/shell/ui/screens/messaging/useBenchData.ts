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
import { appendDedup, reconcileLoadedMessages, settleOptimisticMessage } from './messageList.js';
import { createDesignData } from './designData.js';
export { SELF_ID } from './records.js';
export { unreadMessages } from './unread.js';

/** The signed-in person at this seam. The server maps the human's personId to
 * the literal 'me' on every ChatMessage it serves (server/core/methods.ts), so
 * this IS the wire contract, not a guess. */
type SendOutcome = Awaited<ReturnType<ShellServices['sendMessage']>>;

export interface BenchDataApi {
  data: ReturnType<typeof createDesignData>;
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
    setPendingConvos((prev) => prev.filter((held) => !list.some((convo) => convo.id === held.id)));
    // S2: a spawn defines agents mid-session — refresh defs with conversations
    // so a new participant renders its displayName, never a raw id.
    void services.agents?.listAgents().then(setAgents).catch(() => {});
    await loadMessagesFor(list.map((c) => c.id));
    setReady(true);
  }, [services, loadMessagesFor]);

  const allConversations = useMemo(() => {
    const known = new Set(conversations.map((convo) => convo.id));
    return [...conversations, ...pendingConvos.filter((held) => !known.has(held.id))];
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
    setPendingConvos((prev) => (prev.some((convo) => convo.id === summary.id) ? prev : [...prev, summary]));
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

  const data = useMemo(() => createDesignData({
    conversations: allConversations,
    messagesByConversation: messagesByConvo,
    agents,
    tracker,
    providerAvailability: services.providerAvailability,
    selectedId: props.selectedId,
  }), [allConversations, messagesByConvo, agents, tracker, services, props.selectedId, presenceTick]);

  const findMessage = useCallback((conversationId: string, messageId: string) => (
    messagesByConvo.get(conversationId)?.find((msg) => msg.id === messageId)
  ), [messagesByConvo]);

  // S3: the newest COMMITTED message — the cursor never advances onto a
  // pending/failed local row (those ids are not truth).
  const lastMessageId = useCallback((conversationId: string) => (
    [...(messagesByConvo.get(conversationId) ?? [])]
      .filter((msg) => !msg.pending && !msg.failed)
      .at(-1)?.id
  ), [messagesByConvo]);

  return {
    data, ready, conversations: allConversations,
    appendLocal, settleLocal, appendLocalConversation, findMessage, lastMessageId,
    refreshConversations,
  };
}

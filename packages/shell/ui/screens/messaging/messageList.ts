// shell/ui/screens/messaging/messageList.ts — G1 glitch fix: optimistic echo
// and the server 'message' broadcast both carry the SAME message id; appending
// both rendered every sent message twice. All thread mutations go through
// these helpers so a message id appears at most once in the list.
import type { ChatMessage } from '../../../contract/index.js';
import type { ShellServices } from '../../../contract/services.js';
import { dedupeById as dedupe } from '../../listDedupe.js';

/** Drop duplicate ids, keeping the FIRST occurrence (earliest render wins). */
export function dedupeById(list: ChatMessage[]): ChatMessage[] {
  return dedupe(list);
}

/** Append an incoming message unless its id is already in the list. */
export function appendDedup(cur: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  if (cur.some((m) => m.id === incoming.id)) return cur;
  return [...cur, incoming];
}

/**
 * A thread read may have started before a local optimistic send or a socket
 * event. Merge its snapshot instead of replacing newer local truth. Messages
 * from a previously-selected conversation are deliberately excluded.
 */
export function reconcileLoadedMessages(
  current: ChatMessage[],
  loaded: ChatMessage[],
  conversationId: string,
): ChatMessage[] {
  const loadedIds = new Set(loaded.map((message) => message.id));
  const loadedOps = new Set(
    loaded.map((message) => message.clientOpId).filter((id): id is string => Boolean(id)),
  );
  const newerLocal = current.filter((message) =>
    message.conversationId === conversationId
    && !loadedIds.has(message.id)
    && !(message.clientOpId && loadedOps.has(message.clientOpId)));
  return dedupeById([...loaded, ...newerLocal]);
}

type SendOutcome = Awaited<ReturnType<ShellServices['sendMessage']>>;

const sendErrorText = (error: string | { code: string; message?: string }): string =>
  typeof error === 'string' ? error : `${error.code}${error.message ? `: ${error.message}` : ''}`;

/** Settle one optimistic row without relying on the timing of thread loading. */
export function settleOptimisticMessage(
  current: ChatMessage[],
  optimisticId: string,
  outcome: SendOutcome,
): ChatMessage[] {
  return dedupeById(current.map((message) => message.id === optimisticId
    ? (outcome.ok
      ? { ...outcome.message, pending: false }
      : { ...message, pending: false, failed: sendErrorText(outcome.error) })
    : message));
}

// shell/ui/screens/messaging/messageList.ts — G1 glitch fix: optimistic echo
// and the server 'message' broadcast both carry the SAME message id; appending
// both rendered every sent message twice. All thread mutations go through
// these helpers so a message id appears at most once in the list.
import type { ChatMessage } from '../../../contract/index.js';
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

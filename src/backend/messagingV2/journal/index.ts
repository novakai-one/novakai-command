/**
 * messagingV2 capability-journal read side (slice N5, D-N5-4): the ONE
 * place app code reads the capability's journal file. The frozen archive
 * (.novakai-command/messages.jsonl) has NO writers since N4 — readers
 * repoint HERE, to the live journal the capability's store-jsonl writes.
 *
 * Line format (verified against store-jsonl): each line is one op object;
 * the ops this reader folds are:
 *   {"op":"acceptance","thread":{…},"message":{…}}  ← MessageCommitted facts
 * Torn lines never block the rest (the old MessageStore's tolerance rule).
 *
 * This is a READ fold, never a writer, never an interval — the exit
 * condition ("no interval touches any journal") is about polling, and this
 * module runs strictly on demand.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The default capability journal path (NVK_MESSAGING_V2_STORE overrides,
 * matching startMessagingV2's storePath resolution). */
export function defaultCapabilityJournalPath(): string {
  return process.env.NVK_MESSAGING_V2_STORE
    ?? path.resolve('.novakai-command/messaging-v2/journal.jsonl');
}

/** The old-envelope shape missionView/mission-history consumers render. */
export interface JournalEnvelope {
  id: string;
  from: string;          // senderId (personId)
  to: string;            // threadId
  delivery: 'normal' | 'interrupt';
  body: string;
  threadId: string;
  createdAt: string;
  status: 'delivered';
}

interface AcceptanceOp {
  op: 'acceptance';
  message: {
    id: string;
    threadId: string;
    senderId: string;
    priority?: string;
    createdAt: string;
    body?: { text?: string };
  };
}

function parseOp(line: string): AcceptanceOp | null {
  try {
    const parsed = JSON.parse(line) as Partial<AcceptanceOp> | null;
    if (parsed?.op !== 'acceptance') return null;
    const message = parsed.message;
    if (typeof message?.id !== 'string' || typeof message.senderId !== 'string') return null;
    if (typeof message.createdAt !== 'string' || Number.isNaN(Date.parse(message.createdAt))) return null;
    return parsed as AcceptanceOp;
  } catch {
    return null; // torn/corrupt line never blocks the rest
  }
}

function linesOf(journalPath: string): string[] {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

/** Every MessageCommitted fact as an envelope-shaped row. Fold semantics
 * (the old journal's, preserved): by id, LAST line wins, first-occurrence
 * order — a defensive fold; capability acceptance ops are unique by id. */
export function readJournalEnvelopes(journalPath: string): JournalEnvelope[] {
  const byId = new Map<string, JournalEnvelope>();
  for (const line of linesOf(journalPath)) {
    const record = parseOp(line);
    if (record === null) continue;
    byId.set(record.message.id, {
      id: record.message.id,
      from: record.message.senderId,
      'to': record.message.threadId,
      delivery: record.message.priority === 'urgent' ? 'interrupt' : 'normal',
      body: record.message.body?.text ?? '',
      threadId: record.message.threadId,
      createdAt: record.message.createdAt,
      status: 'delivered',
    });
  }
  return [...byId.values()];
}

/** Last activity instant (ms) per senderId — the people-liveness input. */
export function lastActivityBySenderId(journalPath: string): Map<string, number> {
  const lastByPersonId = new Map<string, number>();
  for (const line of linesOf(journalPath)) {
    const record = parseOp(line);
    if (record === null) continue;
    const stamp = Date.parse(record.message.createdAt);
    if (stamp > (lastByPersonId.get(record.message.senderId) ?? Number.NEGATIVE_INFINITY)) {
      lastByPersonId.set(record.message.senderId, stamp);
    }
  }
  return lastByPersonId;
}

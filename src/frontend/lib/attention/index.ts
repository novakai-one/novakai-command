// Amber engine — exactly ONE gold attention signal app-wide. A needsYou
// queue is derived from live state (an open approval, failed tunnel
// deliveries); only its head carries gold, everything else stays
// monochrome. Resolving the head does not snap: the item settles to sage
// (SETTLE_MS), the screen holds calm for a beat (BEAT_MS), and only then
// does the next item take the gold. The release is the product's signature
// moment — it must feel like the app exhaling, not a cursor moving.
import { useSyncExternalStore } from 'react';
import type { ThreadProjection } from '../../../shared/provider/schema.js';
import type { TunnelEnvelope } from '../messagingV2/index.js';

export type AttentionKind = 'approval' | 'failed-message';

export interface AttentionItem {
  /** Stable identity: approval:<eventId> / message:<envelopeId>. */
  id: string;
  kind: AttentionKind;
  /** Rail routing — which thread row carries the gold dot. */
  threadId: string | null;
  /** Ordering: older needs win within a kind. */
  since: string;
}

export function approvalItemId(eventId: string): string {
  return `approval:${eventId}`;
}

export function messageItemId(envelopeId: string): string {
  return `message:${envelopeId}`;
}

/** An approval still standing as the thread's newest word needs Chris. */
export function approvalItem(projection: ThreadProjection | null): AttentionItem | null {
  const last = projection?.events[projection.events.length - 1];
  if (!projection || last?.kind !== 'approval') return null;
  return { id: approvalItemId(last.id), kind: 'approval', threadId: projection.thread.id, since: last.timestamp };
}

/** Failed deliveries need Chris until he clicks through (dismisses) them. */
export function failedMessageItems(
  envelopes: TunnelEnvelope[],
  dismissed: ReadonlySet<string>,
): AttentionItem[] {
  return envelopes
    .filter((envelope) => envelope.status === 'failed' && !dismissed.has(messageItemId(envelope.id)))
    .map((envelope) => ({
      id: messageItemId(envelope.id),
      kind: 'failed-message' as const,
      threadId: envelope.threadId ?? null,
      since: envelope.createdAt,
    }));
}

/** Priority: a waiting approval outranks failed sends; then oldest first. */
export function buildAttentionQueue(
  projection: ThreadProjection | null,
  envelopes: TunnelEnvelope[],
  dismissed: ReadonlySet<string>,
): AttentionItem[] {
  const approval = approvalItem(projection);
  const failed = failedMessageItems(envelopes, dismissed)
    .sort((left, right) => left.since.localeCompare(right.since));
  return approval ? [approval, ...failed] : failed;
}

export interface AttentionView {
  /** The one item holding gold right now. */
  goldId: string | null;
  goldThreadId: string | null;
  /** The just-resolved item, reading sage while it settles. */
  settlingId: string | null;
  settlingThreadId: string | null;
}

/** Injectable timer: schedule(fn, ms) returns a cancel. */
export type AttentionScheduler = (callback: () => void, delayMs: number) => () => void;

export const SETTLE_MS = 900;
export const BEAT_MS = 500;

const EMPTY_VIEW: AttentionView = { goldId: null, goldThreadId: null, settlingId: null, settlingThreadId: null };

function defaultScheduler(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

export class AttentionEngine {
  private queue: AttentionItem[] = [];
  private gold: AttentionItem | null = null;
  private settling: AttentionItem | null = null;
  private inReleaseWindow = false;
  private cancelTimer: (() => void) | null = null;
  private snapshot: AttentionView = EMPTY_VIEW;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly schedule: AttentionScheduler = defaultScheduler) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): AttentionView => this.snapshot;

  /** Feed the current queue; the engine decides who holds gold and when. */
  update(queue: AttentionItem[]): void {
    this.queue = queue;
    if (this.gold && queue.some((item) => item.id === this.gold?.id)) return;
    if (this.gold) return this.release(this.gold);
    this.promote();
  }

  /** The signature moment: gold fades, the item reads sage, the screen holds
   * a beat of calm, and only then may the next item take the gold. */
  private release(resolved: AttentionItem): void {
    this.cancelTimer?.();
    this.gold = null;
    this.settling = resolved;
    this.inReleaseWindow = true;
    this.emit();
    this.cancelTimer = this.schedule(() => this.finishSettle(), SETTLE_MS);
  }

  private finishSettle(): void {
    this.settling = null;
    this.emit();
    this.cancelTimer = this.schedule(() => this.finishBeat(), BEAT_MS);
  }

  private finishBeat(): void {
    this.inReleaseWindow = false;
    this.cancelTimer = null;
    this.promote();
  }

  private promote(): void {
    if (this.inReleaseWindow || this.gold) return;
    const next = this.queue[0] ?? null;
    if (!next) return;
    this.gold = next;
    this.emit();
  }

  private emit(): void {
    this.snapshot = {
      goldId: this.gold?.id ?? null,
      goldThreadId: this.gold?.threadId ?? null,
      settlingId: this.settling?.id ?? null,
      settlingThreadId: this.settling?.threadId ?? null,
    };
    for (const listener of this.listeners) listener();
  }
}

// One engine for the whole app — that is the point.
const sharedEngine = new AttentionEngine();

export function updateAttentionQueue(queue: AttentionItem[]): void {
  sharedEngine.update(queue);
}

/** Live view of who holds gold / who is settling — rail rows, chat blocks
 * and tunnel rows compare their own ids against it. */
export function useAttention(): AttentionView {
  return useSyncExternalStore(sharedEngine.subscribe, sharedEngine.getSnapshot);
}

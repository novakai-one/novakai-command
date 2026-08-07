// shell/contract/renderer.ts — thread renderer with user-set speed (SHL-007,
// DEC-S7, R3-27). Incoming text lands in a BOUNDED backlog; the renderer
// consumes at the user's tokens/sec. Cap overflow flushes OLDEST and draws a
// "…" gap marker. Closing a chat discards the backlog (store is durable).
// Speed changes apply to the unrendered backlog immediately.
export const DEFAULT_BUFFER_CAP_TOKENS = 10_000;

export interface RenderedChunk {
  text: string;
  /** True when a flush-oldest gap precedes this chunk (draw "…" marker). */
  gapBefore: boolean;
}

export interface RendererSnapshot {
  rendered: string;
  backlogTokens: number;
  gapCount: number;
}

export function countTokens(text: string): number {
  // Cheap deterministic estimate (~4 chars/token) — a budget, not a tokenizer.
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

export class ThreadRenderer {
  private backlog = '';
  private rendered = '';
  private speed: number; // tokens per second
  private cap: number;
  private gapCount = 0;
  private pendingGap = false;
  private carry = 0; // fractional token budget

  constructor(opts: { speed?: number; capTokens?: number } = {}) {
    this.speed = opts.speed ?? 240;
    this.cap = opts.capTokens ?? DEFAULT_BUFFER_CAP_TOKENS;
  }

  /** SHL-007: pacing change applies to the UNRENDERED backlog immediately. */
  setSpeed(tokensPerSecond: number): void {
    this.speed = tokensPerSecond;
  }

  getSpeed(): number {
    return this.speed;
  }

  /** Ingest new text. On cap overflow: flush-oldest + gap marker (R3-27). */
  feed(text: string): void {
    this.backlog += text;
    let tokens = countTokens(this.backlog);
    while (tokens > this.cap && this.backlog.length > 0) {
      const overflowTokens = tokens - this.cap;
      const dropChars = Math.min(this.backlog.length, overflowTokens * 4);
      this.backlog = this.backlog.slice(dropChars);
      this.gapCount += 1;
      this.pendingGap = true;
      tokens = countTokens(this.backlog);
    }
  }

  /** Advance by dtMs; returns the newly rendered chunk (may be empty). */
  tick(dtMs: number): RenderedChunk {
    if (this.backlog.length === 0) return { text: '', gapBefore: false };
    this.carry += (this.speed * dtMs) / 1000;
    const tokensOut = Math.floor(this.carry);
    if (tokensOut <= 0) return { text: '', gapBefore: false };
    this.carry -= tokensOut;
    const chars = Math.min(this.backlog.length, tokensOut * 4);
    const out = this.backlog.slice(0, chars);
    this.backlog = this.backlog.slice(chars);
    this.rendered += out;
    const gapBefore = this.pendingGap;
    this.pendingGap = false;
    return { text: out, gapBefore };
  }

  /** Flush everything now (e.g. when the user sets speed to max). */
  flushAll(): RenderedChunk {
    const out = this.backlog;
    this.backlog = '';
    this.rendered += out;
    const gapBefore = this.pendingGap;
    this.pendingGap = false;
    return { text: out, gapBefore };
  }

  snapshot(): RendererSnapshot {
    return { rendered: this.rendered, backlogTokens: countTokens(this.backlog), gapCount: this.gapCount };
  }

  /** Closing a chat discards the backlog; the stored message object is untouched. */
  discard(): void {
    this.backlog = '';
    this.rendered = '';
    this.gapCount = 0;
    this.pendingGap = false;
    this.carry = 0;
  }
}

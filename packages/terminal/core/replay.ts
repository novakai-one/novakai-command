// Bounded ordered output stream (§7, §18.2).
//
// Terminal output is a stream, not history. It is capped by bytes, and when a
// caller asks for a sequence that has aged out the answer is an explicit GAP —
// never silently-different bytes, and never a pretend-complete replay.
import type { TerminalSessionId } from '@novakai/foundation/contract';
import type { TerminalOutputFrame } from '../contract/api.js';

export interface OutputChunk {
  readonly sequence: number;
  readonly bytes: Buffer;
}

export const DEFAULT_REPLAY_BYTES = 256 * 1024;

export class ReplayBuffer {
  private readonly chunks: OutputChunk[] = [];
  private bytesHeld = 0;
  private lastSequence = 0;
  private earliestDropped = 0;

  constructor(private readonly maxBytes: number = DEFAULT_REPLAY_BYTES) {}

  append(bytes: Buffer): OutputChunk {
    this.lastSequence += 1;
    const chunk: OutputChunk = { sequence: this.lastSequence, bytes };
    this.chunks.push(chunk);
    this.bytesHeld += bytes.byteLength;
    this.evict();
    return chunk;
  }

  private evict(): void {
    while (this.bytesHeld > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (!dropped) return;
      this.bytesHeld -= dropped.bytes.byteLength;
      this.earliestDropped = dropped.sequence;
    }
  }

  /** Oldest sequence still replayable; 0 while nothing has been produced. */
  earliestSequence(): number {
    return this.chunks[0]?.sequence ?? this.earliestDropped;
  }

  latestSequence(): number {
    return this.lastSequence;
  }

  /**
   * Frames strictly after `afterSequence`. A gap frame leads the result when
   * the requested position has already aged out of the buffer.
   */
  replay(
    terminalSessionId: TerminalSessionId, afterSequence: number,
  ): TerminalOutputFrame[] {
    const frames: TerminalOutputFrame[] = [];
    const earliest = this.earliestSequence();
    const missed = this.chunks.length > 0 && afterSequence + 1 < earliest;
    if (missed) {
      frames.push({
        kind: 'gap',
        ...(afterSequence > 0 ? { requestedAfter: afterSequence } : {}),
        earliestAvailable: earliest,
        latestAvailable: this.lastSequence,
      });
    }
    for (const chunk of this.chunks) {
      if (chunk.sequence <= afterSequence) continue;
      frames.push(toBytesFrame(terminalSessionId, chunk));
    }
    return frames;
  }
}

export function toBytesFrame(
  terminalSessionId: TerminalSessionId, chunk: OutputChunk,
): TerminalOutputFrame {
  return {
    kind: 'bytes',
    terminalSessionId,
    sequence: chunk.sequence,
    base64: chunk.bytes.toString('base64'),
  };
}

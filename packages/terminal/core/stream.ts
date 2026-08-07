// Reading the ordered output stream.
//
// Buffered replay first, then live frames, in one uninterrupted sequence — so
// a controller that attaches mid-session sees exactly what it missed, or an
// explicit gap when it missed more than the buffer holds.
import {
  b3fail, b3ok, type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import type { ReadTerminalStreamInput, TerminalOutputFrame } from '../contract/api.js';
import { unknownSessionError, type TerminalCore } from './context.js';
import type { PtyExit } from '../contract/ports.js';
import type { TerminalSession } from '../contract/records.js';
import type { LiveSession } from './live.js';

export async function* readTerminalStream(
  core: TerminalCore,
  principal: AuthenticatedPrincipal,
  input: ReadTerminalStreamInput,
): AsyncIterable<B3Result<TerminalOutputFrame>> {
  void principal;
  const stored = await core.store.read<TerminalSession>('terminalSession', input.terminalSessionId);
  if (!stored.ok) {
    yield stored;
    return;
  }
  if (stored.value === null) {
    yield b3fail(unknownSessionError(input.terminalSessionId));
    return;
  }

  const live = core.live.lookup(input.terminalSessionId);
  if (!live) {
    // A final session with no live process still answers honestly: whatever
    // the record says happened, and no pretend replay.
    yield b3ok(exitFrame(stored.value));
    return;
  }
  yield* followSession(live, input);
}

async function* followSession(
  live: LiveSession, input: ReadTerminalStreamInput,
): AsyncIterable<B3Result<TerminalOutputFrame>> {
  const queue = new FrameQueue();
  const unsubscribe = live.subscribe((frame) => queue.push(frame));
  try {
    for (const frame of live.replay.replay(input.terminalSessionId, input.afterOutputSequence ?? 0)) {
      yield b3ok(frame);
    }
    if (input.replayOnly === true) return;
    if (live.exit !== null) {
      yield b3ok(exitFrame(live.exit));
      return;
    }
    for await (const frame of queue) {
      yield b3ok(frame);
      if (frame.kind === 'exit') return;
    }
  } finally {
    unsubscribe();
    queue.close();
  }
}

function exitFrame(source: PtyExit | TerminalSession): TerminalOutputFrame {
  return {
    kind: 'exit',
    ...(source.exitCode === undefined ? {} : { exitCode: source.exitCode }),
    ...(source.signal === undefined ? {} : { signal: source.signal }),
  };
}

/** Back-pressure-free hand-off from the synchronous PTY callback to the reader. */
class FrameQueue {
  private readonly pending: TerminalOutputFrame[] = [];
  private waiting: ((frame: TerminalOutputFrame | null) => void) | null = null;
  private closed = false;

  push(frame: TerminalOutputFrame): void {
    if (this.closed) return;
    const waiter = this.waiting;
    if (!waiter) {
      this.pending.push(frame);
      return;
    }
    this.waiting = null;
    waiter(frame);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiting;
    this.waiting = null;
    if (waiter) waiter(null);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TerminalOutputFrame> {
    while (!this.closed) {
      const buffered = this.pending.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      const next = await new Promise<TerminalOutputFrame | null>((resolve) => {
        this.waiting = resolve;
      });
      if (next === null) return;
      yield next;
    }
  }
}

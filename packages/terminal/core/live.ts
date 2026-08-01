// Runtime-private per-session state: the live PTY handle, the replay window,
// the input sequence, who is currently working, and the fan-out to readers.
//
// None of this is durable. A Runtime restart loses it, which is exactly why
// boot recovery reports honestly rather than claiming continuous execution
// (DEC-B3V4-23).
import type {
  ActivityGeneration, ProviderTurnId, TerminalSessionId,
} from '@novakai/foundation/contract';
import type { PtyExit, PtyHandle } from '../contract/ports.js';
import type { ActiveProviderTurn } from '../contract/records.js';
import type { TerminalOutputFrame } from '../contract/api.js';
import { ReplayBuffer, toBytesFrame } from './replay.js';

type FrameListener = (frame: TerminalOutputFrame) => void;

/**
 * Where every input stream starts. Named once, because three places have to
 * agree on it: the live counter, the write guard, and the view that tells a
 * newly attached controller where the stream is.
 */
export const FIRST_INPUT_SEQUENCE = 1;

export class LiveSession {
  readonly replay: ReplayBuffer;
  /** Next input sequence a writer must claim. Starts at 1. */
  nextInputSequence: number = FIRST_INPUT_SEQUENCE;
  activeTurn: ActiveProviderTurn | null = null;
  exit: PtyExit | null = null;
  appliedViewport: { columns: number; rows: number };
  private readonly listeners = new Set<FrameListener>();

  constructor(
    readonly sessionId: TerminalSessionId,
    readonly pty: PtyHandle,
    columns: number,
    rows: number,
    replayBytes: number,
  ) {
    this.replay = new ReplayBuffer(replayBytes);
    this.appliedViewport = { columns, rows };
    pty.onData((chunk) => this.publishBytes(chunk));
    pty.onExit((exit) => this.publishExit(exit));
  }

  private publishBytes(chunk: Buffer): void {
    const appended = this.replay.append(chunk);
    this.broadcast(toBytesFrame(this.sessionId, appended));
  }

  private publishExit(exit: PtyExit): void {
    this.exit = exit;
    this.broadcast({
      kind: 'exit',
      ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
      ...(exit.signal === undefined ? {} : { signal: exit.signal }),
    });
  }

  private broadcast(frame: TerminalOutputFrame): void {
    for (const listener of [...this.listeners]) listener(frame);
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** True when the tuple names the turn Runtime last declared active. */
  targets(providerTurnId: ProviderTurnId, activityGeneration: ActivityGeneration): boolean {
    const turn = this.activeTurn;
    return turn !== null
      && turn.providerTurnId === providerTurnId
      && turn.activityGeneration === activityGeneration;
  }
}

export class LiveSessions {
  private readonly sessions = new Map<string, LiveSession>();

  track(session: LiveSession): void {
    this.sessions.set(session.sessionId, session);
  }

  lookup(sessionId: TerminalSessionId): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  forget(sessionId: TerminalSessionId): void {
    this.sessions.delete(sessionId);
  }

  list(): readonly LiveSession[] {
    return [...this.sessions.values()];
  }
}

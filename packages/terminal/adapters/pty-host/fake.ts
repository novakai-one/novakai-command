// Deterministic in-memory PTY host. The test adapter at the same seam the
// real one uses — so the contract suite runs the SAME code paths without a
// real process, and a race test can decide exactly when bytes arrive.
import { b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type { PtyExit, PtyHandle, PtyHost, PtyLaunchSpec } from '../../contract/ports.js';

export interface FakePty extends PtyHandle {
  /** What this PTY was started with — the authority, viewport and cwd. */
  readonly spec: PtyLaunchSpec;
  /** Everything the session has been sent, in order. */
  readonly written: readonly string[];
  readonly resizes: readonly { columns: number; rows: number }[];
  readonly killed: boolean;
  /** Push output as if the process produced it. */
  emit(text: string): void;
  /** End the process from the outside, as a real one can end at any moment. */
  finish(exit: PtyExit): void;
  /**
   * Every turn this session has actually been SENT, as a TUI composer would
   * see them: text accumulates, and a turn exists only once the submit key
   * arrives on its own.
   *
   * Only populated when the host was built with `composer: true`. Reading
   * `written` instead answers a different question — what bytes arrived — and a
   * test that replies to bytes cannot tell a sent turn from one sitting in a
   * composer for ever (NVK-KIMI-031 finding 3).
   */
  readonly turns: readonly string[];
  /** Called with each submitted turn, so a scripted provider can answer it. */
  onTurn(listener: (turn: string) => void): void;
}

const SUBMIT_KEY = String.fromCharCode(13);

class FakePtyHandle implements FakePty {
  readonly written: string[] = [];
  readonly resizes: { columns: number; rows: number }[] = [];
  readonly turns: string[] = [];
  killed = false;
  private alive = true;
  private composing = '';
  private readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  private readonly exitListeners: ((exit: PtyExit) => void)[] = [];
  private readonly turnListeners: ((turn: string) => void)[] = [];

  constructor(
    readonly processRef: string,
    readonly spec: PtyLaunchSpec,
    private readonly echoInput = false,
    private readonly composer = false,
  ) {}

  write(data: string): void {
    if (!this.alive) return;
    this.written.push(data);
    // A real PTY in canonical mode echoes what is typed at it, which is why an
    // echoing fake is the faithful one: it is the shape in which a prompt can
    // arrive back as if the agent had said it.
    if (this.echoInput) this.emit(data.replace(/\r/g, '\n'));
    if (this.composer) this.compose(data);
  }

  /**
   * A TUI composer, modelled at the byte seam.
   *
   * Text accumulates. A turn EXISTS only when the submit key arrives as its own
   * write — because a big fast burst is taken for a paste, and a submit key
   * inside that burst is absorbed into the pasted text instead of sending it.
   * That is not a modelling flourish: it was measured against `claude` 2.1.219
   * on 2026-08-02, where a 554-character turn with the Enter inline was never
   * submitted in 6 trials and the same turn with the Enter as its own write was
   * submitted every time.
   */
  private compose(data: string): void {
    if (data === SUBMIT_KEY) {
      const turn = this.composing;
      this.composing = '';
      if (turn === '') return;
      this.turns.push(turn);
      for (const listener of this.turnListeners) listener(turn);
      return;
    }
    // Anything else is pasted text — including a submit key riding along inside
    // it, which a paste-detecting TUI keeps as a character rather than sending.
    this.composing += data;
  }

  onTurn(listener: (turn: string) => void): void {
    this.turnListeners.push(listener);
  }

  resize(columns: number, rows: number): void {
    if (!this.alive) return;
    this.resizes.push({ columns, rows });
  }

  kill(): void {
    this.killed = true;
    this.finish({ signal: 'SIGTERM' });
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exit: PtyExit) => void): void {
    this.exitListeners.push(listener);
  }

  isAlive(): boolean {
    return this.alive;
  }

  emit(text: string): void {
    if (!this.alive) return;
    const chunk = Buffer.from(text, 'utf8');
    for (const listener of this.dataListeners) listener(chunk);
  }

  finish(exit: PtyExit): void {
    if (!this.alive) return;
    this.alive = false;
    for (const listener of this.exitListeners) listener(exit);
  }
}

export interface FakePtyHost extends PtyHost {
  readonly started: readonly FakePty[];
  /** The most recently started process, which is what a test usually means. */
  latest(): FakePty;
  /** Make the next start() fail, to prove a launch failure is typed data. */
  failNextStart(message: string): void;
  /** Pretend a recorded process no longer exists (runtime restart, power loss). */
  forget(processRef: string): void;
}

export interface FakePtyHostOptions {
  /** Echo written bytes back as output, the way a real PTY does. */
  readonly echoInput?: boolean;
  /**
   * Behave like a TUI composer rather than a byte sink: accumulate text and
   * record a TURN only when the submit key arrives as its own write.
   *
   * A test that answers as soon as bytes appear proves nothing about
   * submission — it reaches `ready` whether or not the Enter is ever sent.
   */
  readonly composer?: boolean;
}

export function createFakePtyHost(options: FakePtyHostOptions = {}): FakePtyHost {
  const started: FakePtyHandle[] = [];
  const forgotten = new Set<string>();
  let failure: string | null = null;
  let counter = 0;

  return {
    started,
    latest(): FakePty {
      const last = started[started.length - 1];
      if (!last) throw new Error('no fake PTY has been started');
      return last;
    },
    failNextStart(message: string): void {
      failure = message;
    },
    forget(processRef: string): void {
      forgotten.add(processRef);
    },
    async start(spec: PtyLaunchSpec): Promise<B3Result<PtyHandle>> {
      if (failure !== null) {
        const message = failure;
        failure = null;
        return b3fail({
          code: 'StoreUnavailable', message,
          details: { owner: 'terminal', cause: 'pty-launch-failed' }, retryable: true,
        });
      }
      counter += 1;
      const handle = new FakePtyHandle(
        `fake-pty:${counter}`, spec, options.echoInput ?? false, options.composer ?? false,
      );
      started.push(handle);
      return b3ok(handle);
    },
    probe(processRef: string): boolean {
      if (forgotten.has(processRef)) return false;
      return started.some((item) => item.processRef === processRef && item.isAlive());
    },
  };
}

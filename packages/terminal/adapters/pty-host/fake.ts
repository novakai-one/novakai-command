// Deterministic in-memory PTY host. The test adapter at the same seam the
// real one uses — so the contract suite runs the SAME code paths without a
// real process, and a race test can decide exactly when bytes arrive.
import { b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type { PtyExit, PtyHandle, PtyHost, PtyLaunchSpec } from '../../contract/ports.js';

export interface FakePty extends PtyHandle {
  /** Everything the session has been sent, in order. */
  readonly written: readonly string[];
  readonly resizes: readonly { columns: number; rows: number }[];
  readonly killed: boolean;
  /** Push output as if the process produced it. */
  emit(text: string): void;
  /** End the process from the outside, as a real one can end at any moment. */
  finish(exit: PtyExit): void;
}

class FakePtyHandle implements FakePty {
  readonly written: string[] = [];
  readonly resizes: { columns: number; rows: number }[] = [];
  killed = false;
  private alive = true;
  private readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  private readonly exitListeners: ((exit: PtyExit) => void)[] = [];

  constructor(readonly processRef: string, readonly spec: PtyLaunchSpec) {}

  write(data: string): void {
    if (!this.alive) return;
    this.written.push(data);
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

export function createFakePtyHost(): FakePtyHost {
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
      const handle = new FakePtyHandle(`fake-pty:${counter}`, spec);
      started.push(handle);
      return b3ok(handle);
    },
    probe(processRef: string): boolean {
      if (forgotten.has(processRef)) return false;
      return started.some((item) => item.processRef === processRef && item.isAlive());
    },
  };
}

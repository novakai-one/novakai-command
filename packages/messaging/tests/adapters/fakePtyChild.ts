/**
 * A fake PTY child (tests/adapters helper): structurally satisfies
 * PtyChildLike so the PTY transport adapter runs without spawning real
 * processes. Records every stdin write; exit()/failNextWrite() script the
 * lane's death and transient failures.
 */

import type { PtyChildLike } from "../../adapters/presence-transport-pty.js";

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

export class FakePtyChild implements PtyChildLike {
  readonly written: string[] = [];
  killed = false;
  exitCode: number | null = null;
  /** When set, the next write confirms with this error (transient lane failure). */
  private nextWriteError: Error | undefined;
  /** When true, write callbacks never fire (a hung lane — deadline evidence). */
  hangWrites = false;
  /**
   * When true, the child ignores SIGTERM (records it, stays alive); only
   * SIGKILL kills — the closeAll escalation leg (audit F5).
   */
  surviveTerm = false;
  /** Every non-probe signal received, in order (closeAll escalation evidence). */
  readonly signalsReceived: Array<number | NodeJS.Signals | undefined> = [];
  private readonly exitListeners: ExitListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  readonly stdin = {
    write: (chunk: string, callback: (error: Error | null | undefined) => void): boolean => {
      if (this.hangWrites) return true; // the callback never fires — the deadline must cut in
      const error = this.nextWriteError;
      this.nextWriteError = undefined;
      if (error === undefined) this.written.push(chunk);
      queueMicrotask(() => callback(error ?? null));
      return true;
    },
  };

  on(event: "exit", listener: ExitListener): unknown;
  on(event: "error", listener: ErrorListener): unknown;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): unknown {
    if (event === "exit") this.exitListeners.push(listener as ExitListener);
    else this.errorListeners.push(listener as ErrorListener);
    return this;
  }

  /** Script the next write to confirm with an error. */
  failNextWrite(message = "write blew up"): void {
    this.nextWriteError = new Error(message);
  }

  /** The process exits — the adapter's liveness path must observe it. */
  exit(code = 0): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.killed = true;
    queueMicrotask(() => {
      for (const listener of this.exitListeners) listener(code, null);
    });
  }

  /** Gone WITHOUT an exit event (out-of-band death) — only the signal-0 probe can catch this. */
  vanish(): void {
    this.exitCode = 1;
    this.killed = true;
  }

  /** Signal-0 probe semantics: throws when the process is gone. */
  kill(signal?: number | NodeJS.Signals): boolean {
    if (signal === 0) {
      if (this.exitCode !== null || this.killed) throw new Error("kill ESRCH");
      return true;
    }
    this.signalsReceived.push(signal);
    if (this.surviveTerm && signal !== "SIGKILL" && signal !== 9) {
      return true; // SIGTERM ignored — the escalation must escalate
    }
    this.exit(0);
    return true;
  }

  /** Parsed JSON lines written so far (the far end's observation). */
  receivedJson(): unknown[] {
    return this.written.flatMap((chunk) =>
      chunk
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
    );
  }
}

// The two seams Terminal genuinely varies at.
//
// A seam is only justified where behaviour must vary: a real PTY versus a
// deterministic fake is a real variation, and an epoch fence supplied by the
// Runtime host versus one supplied by a test is a real variation. Everything
// else stays private.
import type { B3Result, RuntimeEpochId } from '@novakai/foundation/contract';

export interface PtyLaunchSpec {
  readonly workingDirectory: string;
  readonly columns: number;
  readonly rows: number;
  /**
   * The opaque launch authority Terminal resolved. A caller never assembles
   * argv: what actually starts is the host's business.
   */
  readonly launchAuthorityRef: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface PtyExit {
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface PtyHandle {
  /** Opaque, host-defined. Terminal stores it; nobody interprets it. */
  readonly processRef: string;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  /** Ends the process. Only ever called through lifecycle authority. */
  kill(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (exit: PtyExit) => void): void;
  /** Whether the underlying process still exists, for honest recovery. */
  isAlive(): boolean;
}

export interface PtyHost {
  start(spec: PtyLaunchSpec): Promise<B3Result<PtyHandle>>;
  /**
   * Is a process recorded under this opaque ref still alive? Used by boot
   * recovery so a restarted Runtime reports what is true rather than assuming.
   */
  probe(processRef: string): boolean;
}

/**
 * DEC-B3V4-27. Only the process holding the OS single-instance lease and the
 * current durable epoch may manage PTYs; a stale host may explain itself but
 * must not mutate.
 */
export interface RuntimeEpochFence {
  activeEpochId(): RuntimeEpochId | null;
  assertActive(epochId?: RuntimeEpochId): B3Result<RuntimeEpochId>;
}

/** Injected so lease expiry is deterministic under test rather than wall-clock luck. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

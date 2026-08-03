// The private wiring every Terminal operation shares.
import type {
  B3ContractError, B3Result, CommandContext, IsoUtc, PublicOperationName, ReceiptStore,
  RecordVersion, TerminalSessionId,
} from '@novakai/foundation/contract';
import { b3err, b3fail, b3ok } from '@novakai/foundation/contract';
import type { Clock, PtyHost, RuntimeEpochFence } from '../contract/ports.js';
import type { TerminalSession } from '../contract/records.js';
import type { LiveSessions } from './live.js';
import type { SessionQueue } from './serialize.js';
import type { TerminalStore } from './store.js';

export interface TerminalCore {
  readonly store: TerminalStore;
  readonly live: LiveSessions;
  readonly queue: SessionQueue;
  readonly ptyHost: PtyHost;
  readonly epochFence: RuntimeEpochFence;
  readonly clock: Clock;
  readonly receipts: ReceiptStore;
  readonly replayBytes: number;
  /** Host observation of a PTY exit that Terminal did not authorise. */
  readonly onUnexpectedExit?: (terminalSessionId: TerminalSessionId) => void;
  /** How long a controller may go unseen before it is `stale` (§13.4). */
  readonly staleAfterMs: number;
}

export const OPERATION = {
  open: 'terminal.openManagedTerminal' as PublicOperationName,
  attach: 'terminal.attachController' as PublicOperationName,
  detach: 'terminal.detachController' as PublicOperationName,
  acquire: 'terminal.acquireInputLease' as PublicOperationName,
  release: 'terminal.releaseInputLease' as PublicOperationName,
  write: 'terminal.writeInput' as PublicOperationName,
  resize: 'terminal.resizeTerminal' as PublicOperationName,
  interrupt: 'terminal.interruptTerminalTurn' as PublicOperationName,
  terminate: 'terminal.terminateTerminal' as PublicOperationName,
  observe: 'terminal.observeControllers' as PublicOperationName,
  reconcile: 'terminal.reconcileAfterRestart' as PublicOperationName,
} as const;

export const FINAL_STATUSES = new Set(['exited', 'failed']);

/** Statuses whose record asserts a process is currently running. */
export const CLAIMS_TO_BE_RUNNING = new Set(['reserved', 'starting', 'live']);

export function unknownSessionError(terminalSessionId: TerminalSessionId): B3ContractError {
  return b3err('UnknownTerminalSession', `no terminal session "${terminalSessionId}"`,
    { terminalSessionId }, false);
}

export function notLiveError(session: TerminalSession): B3ContractError {
  return b3err('TerminalNotLive',
    `terminal session "${session.id}" is ${session.status}`,
    { terminalSessionId: session.id, status: session.status }, false);
}

/** Load a session or fail with the typed absence — never a thrown exception. */
export async function requireSession(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<TerminalSession>> {
  const found = await core.store.read<TerminalSession>('terminalSession', terminalSessionId);
  if (!found.ok) return found;
  if (found.value === null) return b3fail(unknownSessionError(terminalSessionId));
  return b3ok(found.value);
}

export async function requireLiveSession(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<TerminalSession>> {
  const found = await requireSession(core, terminalSessionId);
  if (!found.ok) return found;
  if (found.value.status !== 'live') return b3fail(notLiveError(found.value));
  return found;
}

export function versionOf(record: { readonly recordVersion: RecordVersion }): RecordVersion {
  return record.recordVersion;
}

/**
 * Presence times come from the injected clock, not the wall clock. "Last seen"
 * and "is that too long ago" have to be read off ONE clock, or a test that
 * moves time is comparing two different eras — and so is a machine that sleeps.
 */
export function clockIso(core: TerminalCore): IsoUtc {
  return new Date(core.clock.nowMs()).toISOString() as IsoUtc;
}

/** Positive-integer viewport guard: a zero-column terminal is not a viewport. */
export function viewportIssues(columns: number, rows: number): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (!Number.isInteger(columns) || columns <= 0) issues.push({ path: 'columns', message: 'must be a positive integer' });
  if (!Number.isInteger(rows) || rows <= 0) issues.push({ path: 'rows', message: 'must be a positive integer' });
  return issues;
}

export type CommandRunner = <T>(
  context: CommandContext,
  descriptor: { operation: PublicOperationName; request: unknown; replaySafe: boolean },
  execute: () => Promise<B3Result<T>>,
) => Promise<B3Result<T>>;

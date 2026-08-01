// The private wiring every Terminal operation shares.
import type {
  B3ContractError, B3Result, CommandContext, PublicOperationName, ReceiptStore,
  RecordVersion, TerminalSessionId,
} from '@novakai/foundation/contract';
import { b3err } from '@novakai/foundation/contract';
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
} as const;

export const FINAL_STATUSES = new Set(['exited', 'failed']);

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
  if (found.value === null) return { ok: false, error: unknownSessionError(terminalSessionId) };
  return { ok: true, value: found.value };
}

export async function requireLiveSession(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<TerminalSession>> {
  const found = await requireSession(core, terminalSessionId);
  if (!found.ok) return found;
  if (found.value.status !== 'live') return { ok: false, error: notLiveError(found.value) };
  return found;
}

export function versionOf(record: { readonly recordVersion: RecordVersion }): RecordVersion {
  return record.recordVersion;
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

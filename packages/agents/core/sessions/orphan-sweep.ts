// The boot orphan sweep.
//
// A server that dies while generating leaves `inFlight` set; the boot sweep
// turns that into ONE typed `ReplyInterrupted` per interrupted send — surfaced
// in the thread as "reply interrupted — resend?", NEVER auto-retried.
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import { inFlightFrom, type ProviderSessionRecord } from './record-shape.js';
import type { ProcessProbe } from './process-probe.js';

export interface SweepResult {
  /** One entry per send that was generating when the server died. */
  interrupted: Array<{ sessionId: string; clientOpId: string; reason: 'ReplyInterrupted' }>;
  /** Orphaned child pids we positively identified as ours and reaped. */
  killed: number[];
  /** Typed store failures encountered while closing interrupted turns. */
  errors: StoreError[];
}

export interface SweepDeps {
  readAll(): Promise<Array<{ record: ProviderSessionRecord; version: number }>>;
  patch(
    sessionId: string,
    mutate: (record: ProviderSessionRecord) => Partial<ProviderSessionRecord>,
  ): Promise<Result<ProviderSessionRecord, StoreError>>;
  probe: ProcessProbe;
  now(): string;
}

export async function sweepOrphans(deps: SweepDeps): Promise<SweepResult> {
  const result: SweepResult = { interrupted: [], killed: [], errors: [] };
  for (const { record } of await deps.readAll()) {
    if (record.inFlight.status !== 'generating') continue;
    const { pid, pidStartedAt } = record.inFlight.queue[0]!;
    // Only kill a pid we can PROVE is still the child we
    // spawned — a recycled pid belongs to somebody else's process.
    if (pid !== null && deps.probe.alive(pid) && pidStartedAt !== null && deps.probe.startedAt(pid) === pidStartedAt) {
      deps.probe.kill?.(pid);
      result.killed.push(pid);
    }
    const at = deps.now();
    const patched = await deps.patch(record.sessionId, () => ({
      inFlight: inFlightFrom([]),
      lastInterruption: record.inFlight.queue[0]
        ? { clientOpId: record.inFlight.queue[0].clientOpId, at, reason: 'ReplyInterrupted' as const }
        : null,
      lastActivityAt: at,
    }));
    if (!patched.ok) {
      result.errors.push(patched.error);
      // TraceIncomplete means the object mutation landed and only its
      // mutation trace is incomplete; the interrupted turns are still
      // real. Other failures leave the flags untouched for a later sweep.
      if (patched.error.code !== 'TraceIncomplete') continue;
    }
    for (const turn of record.inFlight.queue) {
      result.interrupted.push({
        sessionId: record.sessionId, clientOpId: turn.clientOpId, reason: 'ReplyInterrupted',
      });
    }
  }
  return result;
}

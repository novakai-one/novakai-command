// The input lease (DEC-B3V4-29).
//
// Many controllers may read. Exactly one lease generation may write. That is
// the whole reason two people cannot interleave keystrokes into one shell.
import {
  b3err, b3ok, mintClientOpId, mintTerminalInputLeaseId, nowIsoUtc,
  type B3ContractError, type B3Result, type CommandContext, type LeaseGeneration,
  type TerminalSessionId,
} from '@novakai/foundation/contract';
import type { LeaseEndedReason, TerminalInputLease } from '../contract/records.js';
import type { Persisted } from './store.js';
import type { TerminalCore } from './context.js';

export async function leasesOf(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<readonly TerminalInputLease[]>> {
  return core.store.list<TerminalInputLease>('terminalInputLease', { terminalSessionId });
}

export function nextGeneration(leases: readonly TerminalInputLease[]): LeaseGeneration {
  const highest = leases.reduce((best, lease) => Math.max(best, lease.generation), 0);
  return (highest + 1) as LeaseGeneration;
}

function expired(lease: TerminalInputLease, nowMs: number): boolean {
  return Date.parse(lease.expiresAt) <= nowMs;
}

/**
 * Settle any lease that is durably `active` but has run out of time, then
 * return the one that genuinely still holds the session. Expiry is evaluated
 * lazily on the way into every lease-touching operation, so a lease can never
 * appear held by a controller whose time ran out while it was quiet.
 */
export async function settleAndFindActive(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<TerminalInputLease | null>> {
  const everyLease = await leasesOf(core, terminalSessionId);
  if (!everyLease.ok) return everyLease;
  const nowMs = core.clock.nowMs();
  let active: TerminalInputLease | null = null;
  for (const lease of everyLease.value) {
    if (lease.state !== 'active') continue;
    if (!expired(lease, nowMs)) {
      active = lease;
      continue;
    }
    const ended = await endLease(core, lease, 'expired', 'expired');
    if (!ended.ok) return ended;
  }
  return b3ok(active);
}

export async function endLease(
  core: TerminalCore,
  lease: TerminalInputLease,
  state: 'released' | 'expired' | 'revoked',
  endedReason: LeaseEndedReason,
): Promise<B3Result<TerminalInputLease>> {
  return core.store.update<TerminalInputLease>(
    'sys_terminal', 'terminalInputLease', lease.id,
    { state, endedReason }, lease.recordVersion, mintClientOpId(),
  );
}

export interface GrantLeaseInput {
  readonly terminalSessionId: TerminalSessionId;
  readonly attachmentId: TerminalInputLease['attachmentId'];
  readonly generation: LeaseGeneration;
  readonly ttlMs: number;
}

export async function grantLease(
  core: TerminalCore, context: CommandContext, input: GrantLeaseInput,
): Promise<B3Result<TerminalInputLease>> {
  const record: Persisted<TerminalInputLease> = {
    kind: 'terminalInputLease',
    id: mintTerminalInputLeaseId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    generation: input.generation,
    expiresAt: new Date(core.clock.nowMs() + input.ttlMs).toISOString() as ReturnType<typeof nowIsoUtc>,
    state: 'active',
  };
  return core.store.create<TerminalInputLease>(context.principal.id, record, mintClientOpId());
}

export function leaseBusyError(lease: TerminalInputLease): B3ContractError {
  return b3err('InputLeaseBusy',
    'another controller currently holds the input lease',
    {
      terminalSessionId: lease.terminalSessionId,
      holderAttachmentId: lease.attachmentId,
      expiresAt: lease.expiresAt,
    }, true);
}

/**
 * A lease conflict a client can actually act on.
 *
 * This is typed and named as a recoverable condition, which is a promise: a
 * caller that reads it and does what it says gets through. It was not keeping
 * that promise. With no lease held it advertised `actual: 0`, and
 * `readWriteTerminalInput` refuses `leaseGeneration: 0` as a validation error —
 * so a client that trusted the answer had no legal value to send, ever. Two
 * changes make the loop unwinnable to enter rather than to leave:
 *
 *   - `actual` is `null` when there is no live lease. Zero is not a generation;
 *     advertising it as one invited exactly the retry the validator rejects.
 *   - `nextAction` says what to DO. When the generation moved, the client may
 *     retry with the one named; when nobody holds the lease there is nothing to
 *     retry with and the answer is `acquire-lease`.
 */
export function generationChangedError(
  expectedGeneration: LeaseGeneration | undefined,
  actualGeneration: LeaseGeneration | 0,
  reason: LeaseEndedReason | 'not-holder' | 'no-active-lease',
): B3ContractError {
  const held = actualGeneration === 0 ? null : actualGeneration;
  return b3err('InputLeaseGenerationChanged',
    `the input lease is no longer generation ${String(expectedGeneration ?? 'unknown')} (${reason})`,
    {
      expected: expectedGeneration ?? null,
      actual: held,
      reason,
      nextAction: held === null ? 'acquire-lease' : 'retry-with-actual-generation',
    }, false);
}

export function ttlIssues(ttlMs: number): { path: string; message: string }[] {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3_600_000) {
    return [{ path: 'ttlMs', message: 'must be a positive integer up to 3600000' }];
  }
  return [];
}

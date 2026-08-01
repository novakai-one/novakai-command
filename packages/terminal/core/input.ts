// Acquiring the right to type, and typing.
import { createHash } from 'node:crypto';
import {
  b3err, b3ok, mintClientOpId, mintTerminalInputAttemptId, nowIsoUtc, validationFailed,
  type B3Result, type CommandContext, type IsoUtc, type LeaseGeneration,
} from '@novakai/foundation/contract';
import type {
  AcquireInputLeaseInput, ReleaseInputLeaseInput, WriteTerminalInput,
} from '../contract/api.js';
import type {
  ControllerAttachment, TerminalInputAttempt, TerminalInputLease,
} from '../contract/records.js';
import {
  endLease, generationChangedError, grantLease, leaseBusyError, leasesOf,
  nextGeneration, settleAndFindActive, ttlIssues,
} from './leases.js';
import { applyAuthoritativeViewport } from './controllers.js';
import type { Persisted } from './store.js';
import { requireLiveSession, type TerminalCore } from './context.js';

async function attachedController(
  core: TerminalCore, terminalSessionId: string, attachmentId: string,
): Promise<B3Result<ControllerAttachment>> {
  const found = await core.store.read<ControllerAttachment>('controllerAttachment', attachmentId);
  if (!found.ok) return found;
  if (found.value === null
    || found.value.terminalSessionId !== terminalSessionId
    || found.value.state !== 'attached') {
    return { ok: false, error: b3err('ValidationFailed',
      `attachment "${attachmentId}" is not attached to "${terminalSessionId}"`,
      { issues: [{ path: 'attachmentId', message: 'not an attached controller' }] }, false) };
  }
  return b3ok(found.value);
}

export async function acquireInputLease(
  core: TerminalCore, context: CommandContext, input: AcquireInputLeaseInput,
): Promise<B3Result<TerminalInputLease>> {
  const issues = ttlIssues(input.ttlMs);
  if (issues.length > 0) return { ok: false, error: validationFailed(issues) };
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  const controller = await attachedController(core, input.terminalSessionId, input.attachmentId);
  if (!controller.ok) return controller;

  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  const held = active.value;

  if (input.mode === 'renew') return renewLease(core, input, held);
  if (held !== null && held.attachmentId === input.attachmentId) return b3ok(held);
  if (held !== null && input.mode === 'acquire-if-free') {
    return { ok: false, error: leaseBusyError(held) };
  }
  if (held !== null) {
    // explicit-takeover: the prior holder learns WHY it lost the lease.
    const revoked = await endLease(core, held, 'revoked', 'takeover');
    if (!revoked.ok) return revoked;
  }

  const all = await leasesOf(core, input.terminalSessionId);
  if (!all.ok) return all;
  const granted = await grantLease(core, context, {
    terminalSessionId: input.terminalSessionId,
    attachmentId: controller.value.id,
    generation: nextGeneration(all.value),
    ttlMs: input.ttlMs,
  });
  if (!granted.ok) return granted;
  // The new holder's viewport becomes authoritative (DEC-B3V4-29).
  const applied = await applyAuthoritativeViewport(core, input.terminalSessionId);
  if (!applied.ok) return applied;
  return granted;
}

async function renewLease(
  core: TerminalCore, input: AcquireInputLeaseInput, held: TerminalInputLease | null,
): Promise<B3Result<TerminalInputLease>> {
  if (held === null || held.attachmentId !== input.attachmentId) {
    return { ok: false, error: generationChangedError(
      input.expectedLeaseGeneration, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ) };
  }
  if (input.expectedLeaseGeneration !== undefined
    && input.expectedLeaseGeneration !== held.generation) {
    return { ok: false, error: generationChangedError(
      input.expectedLeaseGeneration, held.generation, 'not-holder',
    ) };
  }
  return core.store.update<TerminalInputLease>(
    'sys_terminal', 'terminalInputLease', held.id,
    { expiresAt: new Date(core.clock.now() + input.ttlMs).toISOString() as IsoUtc },
    held.recordVersion, mintClientOpId(),
  );
}

export async function releaseInputLease(
  core: TerminalCore, context: CommandContext, input: ReleaseInputLeaseInput,
): Promise<B3Result<TerminalInputLease>> {
  void context;
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  const held = active.value;
  if (held === null || held.id !== input.leaseId || held.generation !== input.generation) {
    return { ok: false, error: generationChangedError(
      input.generation, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ) };
  }
  return endLease(core, held, 'released', 'released');
}

export async function writeInput(
  core: TerminalCore, context: CommandContext, input: WriteTerminalInput,
): Promise<B3Result<TerminalInputAttempt>> {
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  const guarded = await guardWrite(core, input);
  if (!guarded.ok) return guarded;

  const live = core.live.get(input.terminalSessionId);
  if (!live) {
    return { ok: false, error: b3err('TerminalNotLive',
      'the runtime holds no live process for this session',
      { terminalSessionId: input.terminalSessionId, status: session.value.status }, false) };
  }

  const payload = bytesFor(input);
  let outcome: TerminalInputAttempt['outcome'] = 'submitted-confirmed';
  try {
    live.pty.write(payload);
  } catch {
    // The bytes may or may not have reached the process. That uncertainty is
    // recorded, never resolved by guessing or by writing again.
    outcome = 'submitted-unconfirmed';
  }
  const sequence = live.nextInputSequence;
  live.nextInputSequence += 1;

  const record: Persisted<TerminalInputAttempt> = {
    kind: 'terminalInputAttempt',
    id: mintTerminalInputAttemptId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    leaseGeneration: input.leaseGeneration,
    inputSequence: sequence,
    payloadDigest: createHash('sha256').update(payload, 'utf8').digest('hex'),
    kindOfInput: input.kindOfInput,
    outcome,
  };
  return core.store.create<TerminalInputAttempt>(
    context.principal.id, record, mintClientOpId(),
  );
}

/** Raw Ctrl-C is ordinary ordered input under the lease, never a lifecycle path (§13.3). */
/** ETX. Named, because a bare control byte in source is unreadable. */
export const CONTROL_C = '\u0003';

function bytesFor(input: WriteTerminalInput): string {
  if (input.kindOfInput === 'raw-control-c') return CONTROL_C;
  return input.utf8Text ?? '';
}

async function guardWrite(
  core: TerminalCore, input: WriteTerminalInput,
): Promise<B3Result<null>> {
  if (input.kindOfInput !== 'raw-control-c' && (input.utf8Text ?? '') === '') {
    return { ok: false, error: validationFailed([{ path: 'utf8Text', message: 'must not be empty' }]) };
  }
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  const held = active.value;
  if (held === null || held.id !== input.inputLeaseId) {
    return { ok: false, error: generationChangedError(
      input.leaseGeneration, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ) };
  }
  if (held.generation !== input.leaseGeneration) {
    return { ok: false, error: generationChangedError(
      input.leaseGeneration, held.generation, 'takeover',
    ) };
  }
  if (held.attachmentId !== input.attachmentId) {
    return { ok: false, error: generationChangedError(
      input.leaseGeneration, held.generation, 'not-holder',
    ) };
  }
  const live = core.live.get(input.terminalSessionId);
  const expected = live?.nextInputSequence ?? 1;
  if (input.expectedNextInputSequence !== expected) {
    return { ok: false, error: b3err('VersionConflict',
      'the input stream moved on before this write',
      { objectId: input.terminalSessionId, expected: input.expectedNextInputSequence, actual: expected },
      true) };
  }
  return b3ok(null);
}

export function currentGeneration(lease: TerminalInputLease | null): LeaseGeneration | 0 {
  return lease?.generation ?? 0;
}

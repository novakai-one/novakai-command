// Acquiring the right to type, and typing.
import { createHash } from 'node:crypto';
import {
  b3fail, b3err, b3ok, mintClientOpId, mintTerminalInputAttemptId, nowIsoUtc, validationFailed,
  type B3Result, type CommandContext, type IsoUtc, type LeaseGeneration,
} from '@novakai/foundation/contract';
import type {
  AcquireInputLeaseInput, ReleaseInputLeaseInput, WriteTerminalInput,
} from '../contract/api.js';
import type {
  ControllerAttachment, TerminalInputAttempt, TerminalInputLease,
} from '../contract/records.js';
import { requireOwnAttachment, requireTakeoverAuthority } from './authority.js';
import {
  endLease, generationChangedError, grantLease, leaseBusyError, leasesOf,
  nextGeneration, settleAndFindActive, ttlIssues,
} from './leases.js';
import { applyAuthoritativeViewport } from './controllers.js';
import { FIRST_INPUT_SEQUENCE } from './live.js';
import type { Persisted } from './store.js';
import { OPERATION, requireLiveSession, type TerminalCore } from './context.js';
import { activeNotificationReservation } from './notification-input.js';

async function attachedController(
  core: TerminalCore, terminalSessionId: string, attachmentId: string,
): Promise<B3Result<ControllerAttachment>> {
  const found = await core.store.read<ControllerAttachment>('controllerAttachment', attachmentId);
  if (!found.ok) return found;
  if (found.value === null
    || found.value.terminalSessionId !== terminalSessionId
    || found.value.state !== 'attached') {
    return b3fail(b3err('ValidationFailed',
      `attachment "${attachmentId}" is not attached to "${terminalSessionId}"`,
      { issues: [{ path: 'attachmentId', message: 'not an attached controller' }] }, false));
  }
  return b3ok(found.value);
}

async function requireNoNotificationReservation(
  core: TerminalCore, terminalSessionId: AcquireInputLeaseInput['terminalSessionId'],
): Promise<B3Result<null>> {
  const reservation = await activeNotificationReservation(core, terminalSessionId);
  if (!reservation.ok) return reservation;
  if (reservation.value !== null) {
    return b3fail(b3err('InputLeaseBusy',
      'a reserved Notification input holds the terminal boundary', {
        reason: 'notification-input-reserved',
        notificationInputReservationId: reservation.value.id,
      }, true));
  }
  return b3ok(null);
}

export async function acquireInputLease(
  core: TerminalCore, context: CommandContext, input: AcquireInputLeaseInput,
): Promise<B3Result<TerminalInputLease>> {
  const issues = ttlIssues(input.ttlMs);
  if (issues.length > 0) return b3fail(validationFailed(issues));
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  const controller = await attachedController(core, input.terminalSessionId, input.attachmentId);
  if (!controller.ok) return controller;
  const allowed = requireOwnAttachment(context, controller.value, OPERATION.acquire);
  if (!allowed.ok) return allowed;

  const available = await requireNoNotificationReservation(core, input.terminalSessionId);
  if (!available.ok) return available;

  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;

  const cleared = await clearTheWay(core, context, input, active.value);
  if (cleared !== null) return cleared;

  const everyLease = await leasesOf(core, input.terminalSessionId);
  if (!everyLease.ok) return everyLease;
  const granted = await grantLease(core, context, {
    terminalSessionId: input.terminalSessionId,
    attachmentId: controller.value.id,
    generation: nextGeneration(everyLease.value),
    ttlMs: input.ttlMs,
  });
  if (!granted.ok) return granted;
  // The new holder's viewport becomes authoritative (DEC-B3V4-29).
  const applied = await applyAuthoritativeViewport(core, input.terminalSessionId);
  if (!applied.ok) return applied;
  return granted;
}

/**
 * Decide what happens to whoever holds the lease now. Returns a finished
 * outcome when the caller must NOT be granted a fresh lease, or null when the
 * way is clear to grant one.
 */
async function clearTheWay(
  core: TerminalCore,
  context: CommandContext,
  input: AcquireInputLeaseInput,
  held: TerminalInputLease | null,
): Promise<B3Result<TerminalInputLease> | null> {
  if (input.mode === 'renew') return renewLease(core, input, held);
  if (held === null) return null;
  // Asking again for a lease you already hold is not a race; it is a no-op.
  if (held.attachmentId === input.attachmentId) return b3ok(held);
  if (input.mode === 'acquire-if-free') return b3fail(leaseBusyError(held));

  // explicit-takeover: whose keyboard is being taken decides whether authority
  // is needed (§13.4), so the holder's controller is read, not assumed.
  const holder = await core.store.read<ControllerAttachment>(
    'controllerAttachment', held.attachmentId,
  );
  if (!holder.ok) return holder;
  if (holder.value !== null) {
    const authorised = requireTakeoverAuthority(context, holder.value, OPERATION.acquire);
    if (!authorised.ok) return authorised;
  }
  // The prior holder learns WHY it lost the lease.
  const revoked = await endLease(core, held, 'revoked', 'takeover');
  return revoked.ok ? null : revoked;
}

async function renewLease(
  core: TerminalCore, input: AcquireInputLeaseInput, held: TerminalInputLease | null,
): Promise<B3Result<TerminalInputLease>> {
  if (held === null || held.attachmentId !== input.attachmentId) {
    return b3fail(generationChangedError(
      input.expectedLeaseGeneration, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ));
  }
  if (input.expectedLeaseGeneration !== undefined
    && input.expectedLeaseGeneration !== held.generation) {
    return b3fail(generationChangedError(
      input.expectedLeaseGeneration, held.generation, 'not-holder',
    ));
  }
  return core.store.update<TerminalInputLease>(
    'sys_terminal', 'terminalInputLease', held.id,
    { expiresAt: new Date(core.clock.nowMs() + input.ttlMs).toISOString() as IsoUtc },
    held.recordVersion, mintClientOpId(),
  );
}

export async function releaseInputLease(
  core: TerminalCore, context: CommandContext, input: ReleaseInputLeaseInput,
): Promise<B3Result<TerminalInputLease>> {
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  const held = active.value;
  if (held === null || held.id !== input.leaseId || held.generation !== input.generation) {
    return b3fail(generationChangedError(
      input.generation, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ));
  }
  // Knowing the lease id is not the same as holding the keyboard.
  const holder = await core.store.read<ControllerAttachment>(
    'controllerAttachment', held.attachmentId,
  );
  if (!holder.ok) return holder;
  if (holder.value !== null) {
    const allowed = requireOwnAttachment(context, holder.value, OPERATION.release);
    if (!allowed.ok) return allowed;
  }
  return endLease(core, held, 'released', 'released');
}

export async function writeInput(
  core: TerminalCore, context: CommandContext, input: WriteTerminalInput,
): Promise<B3Result<TerminalInputAttempt>> {
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  // §22: writing terminal input needs an ACTIVE ATTACHMENT and the lease. The
  // attachment is checked first, so a stolen lease id alone types nothing.
  const controller = await attachedController(core, input.terminalSessionId, input.attachmentId);
  if (!controller.ok) return controller;
  const allowed = requireOwnAttachment(context, controller.value, OPERATION.write);
  if (!allowed.ok) return allowed;
  const guarded = await guardWrite(core, input);
  if (!guarded.ok) return guarded;

  const live = core.live.lookup(input.terminalSessionId);
  if (!live) {
    return b3fail(b3err('TerminalNotLive',
      'the runtime holds no live process for this session',
      { terminalSessionId: input.terminalSessionId, status: session.value.status }, false));
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
    source: 'controller',
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
    return b3fail(validationFailed([{ path: 'utf8Text', message: 'must not be empty' }]));
  }
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  const held = active.value;
  if (held === null || held.id !== input.inputLeaseId) {
    return b3fail(generationChangedError(
      input.leaseGeneration, held?.generation ?? 0,
      held === null ? 'no-active-lease' : 'not-holder',
    ));
  }
  if (held.generation !== input.leaseGeneration) {
    return b3fail(generationChangedError(
      input.leaseGeneration, held.generation, 'takeover',
    ));
  }
  if (held.attachmentId !== input.attachmentId) {
    return b3fail(generationChangedError(
      input.leaseGeneration, held.generation, 'not-holder',
    ));
  }
  return checkSequenceClaim(core, input);
}

/**
 * The optimistic position check, which sits ON TOP of the lease rather than in
 * place of it: by the time it runs, the lease, its generation and its holder
 * have all been verified, so exclusivity is already settled.
 */
function checkSequenceClaim(
  core: TerminalCore, input: WriteTerminalInput,
): B3Result<null> {
  const live = core.live.lookup(input.terminalSessionId);
  const expected = live?.nextInputSequence ?? FIRST_INPUT_SEQUENCE;
  // No claim, no conflict: a caller that did not name a position is not making
  // the assertion this check tests.
  if (input.expectedNextInputSequence === undefined) return b3ok(null);
  // A claim of 0 is the assertion "the stream is still empty", which is the only
  // position a client holding the published contract can DERIVE: the spec
  // requires the field and names no surface that returns it, and it never chose
  // a base — `nextInputSequence` appears nowhere in pass2 outside the request
  // field itself. On an untouched stream the assertion is true, so it is
  // honoured; on a stream that has moved it falls through to the conflict below,
  // which carries the real position. Refusing it as MALFORMED instead walled one
  // of the two legal readings out of its first write, with an error naming no
  // way back — the hold-out exam died on exactly that, seventeen rows of it.
  const streamIsEmpty = expected === FIRST_INPUT_SEQUENCE;
  const claimed = input.expectedNextInputSequence === 0 && streamIsEmpty
    ? expected
    : input.expectedNextInputSequence;
  if (claimed === expected) return b3ok(null);
  // `expected`/`actual` follow Foundation's CAS convention — `expected` is what
  // the CALLER claimed — which reads backwards to anyone RECOVERING from the
  // conflict. `expectedNextInputSequence` is named after the request field it
  // belongs in, so a client has nothing to guess and no convention to know:
  // send this value back.
  return b3fail(b3err('VersionConflict',
    'the input stream moved on before this write',
    {
      objectId: input.terminalSessionId,
      expected: input.expectedNextInputSequence,
      actual: expected,
      expectedNextInputSequence: expected,
    },
    true));
}

export function currentGeneration(lease: TerminalInputLease | null): LeaseGeneration | 0 {
  return lease?.generation ?? 0;
}

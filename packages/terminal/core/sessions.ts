// Session lifecycle: open, view, list, terminate, recover.
import {
  b3fail, b3err, b3ok, commandReceiptId, mintClientOpId, mintTerminalSessionId,
  nowIsoUtc, validationFailed,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type CommandReceiptId, type IsoUtc, type RuntimeEpochId, type SystemCommandContext,
  type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  ListTerminalSessionsFilter, OpenManagedTerminalInput, TerminalSessionView,
  TerminateTerminalInput,
} from '../contract/api.js';
import type { ControllerAttachment, TerminalSession } from '../contract/records.js';
import { FIRST_INPUT_SEQUENCE, LiveSession } from './live.js';
import { settleAndFindActive } from './leases.js';
import type { Persisted } from './store.js';
import {
  CLAIMS_TO_BE_RUNNING, clockIso, FINAL_STATUSES, OPERATION, requireSession, viewportIssues,
  type TerminalCore,
} from './context.js';

/**
 * Open, as a durable ladder rather than a spawn (§13.5).
 *
 * `reserved` → `starting` → `live` is written BEFORE, AROUND and AFTER the
 * spawn, so at no instant does a process exist that no record owns. The record
 * carries the open command's own operation id, which is what lets a retry find
 * the PTY its earlier attempt started — §13.5's "adopt same PTY or report
 * recovery" — instead of starting a second one (red gates 25 and 28).
 */
export async function openManagedTerminal(
  core: TerminalCore, context: CommandContext, input: OpenManagedTerminalInput,
): Promise<B3Result<TerminalSession>> {
  const issues = viewportIssues(input.columns, input.rows);
  if (input.workingDirectory.trim() === '') {
    issues.push({ path: 'workingDirectory', message: 'must not be empty' });
  }
  if (issues.length > 0) return b3fail(validationFailed(issues));

  // Only the active Runtime host may own a PTY (red gate 2 + DEC-B3V4-27).
  const epoch = core.epochFence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;

  const operationId = commandReceiptId(
    context.principal.id, OPERATION.open, context.clientOpId,
  );
  const earlier = await earlierAttempt(core, operationId, input);
  if (!earlier.ok) return earlier;
  if (earlier.value.kind === 'settled') return earlier.value.outcome;

  const reserved = earlier.value.kind === 'resume'
    ? b3ok(earlier.value.session)
    : await reserveSession(core, context, input, epoch.value, operationId);
  if (!reserved.ok) return reserved;
  return launchReserved(core, reserved.value, input);
}

type EarlierAttempt =
  /** Nothing was ever attempted under this operation id. */
  | { readonly kind: 'none' }
  /** A record exists but no process was ever started for it. */
  | { readonly kind: 'resume'; readonly session: TerminalSession }
  /** The answer is already known: adopted, replayed, or uncertain. */
  | { readonly kind: 'settled'; readonly outcome: B3Result<TerminalSession> };

async function earlierAttempt(
  core: TerminalCore, operationId: CommandReceiptId, input: OpenManagedTerminalInput,
): Promise<B3Result<EarlierAttempt>> {
  const found = await core.store.list<TerminalSession>(
    'terminalSession', { launchOperationId: operationId },
  );
  if (!found.ok) return found;
  const session = found.value[0];
  if (!session) return b3ok({ kind: 'none' });

  // §13.5: the proof required before advancing a terminal stage is that the
  // fingerprint matches the operation. A different one is a different launch.
  if (session.launchFingerprint !== input.launchFingerprint) {
    return b3ok({ kind: 'settled', outcome: b3fail(b3err('IdempotencyConflict',
      `this operation already launched "${session.launchFingerprint}"`,
      {
        terminalSessionId: session.id,
        originalFingerprint: session.launchFingerprint,
        receivedFingerprint: input.launchFingerprint,
      }, false)) });
  }
  if (session.status === 'reserved') return b3ok({ kind: 'resume', session });
  if (FINAL_STATUSES.has(session.status)) {
    return b3ok({ kind: 'settled', outcome: b3ok(session) });
  }
  // Still claiming to run: adopt the SAME process if this runtime holds it,
  // otherwise say the effect is uncertain rather than repeating it.
  if (core.live.lookup(session.id)) {
    return b3ok({ kind: 'settled', outcome: b3ok(session) });
  }
  return b3ok({ kind: 'settled', outcome: b3fail(b3err('RecoveryRequired',
    `terminal session ${session.id} was left ${session.status} by an earlier attempt`,
    { operationId, stage: session.status, reason: 'effect-outcome-uncertain' }, true)) });
}

async function reserveSession(
  core: TerminalCore,
  context: CommandContext,
  input: OpenManagedTerminalInput,
  runtimeEpochId: RuntimeEpochId,
  launchOperationId: CommandReceiptId,
): Promise<B3Result<TerminalSession>> {
  const record: Persisted<TerminalSession> = {
    kind: 'terminalSession',
    id: mintTerminalSessionId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    owner: input.owner,
    status: 'reserved',
    launchFingerprint: input.launchFingerprint,
    launchOperationId,
    runtimeEpochId,
    privateProcessRef: '', // nothing is owned yet, and the record says so
    workingDirectory: input.workingDirectory,
    outputSequence: 0,
    earliestReplaySequence: 0,
  };
  return core.store.create<TerminalSession>(context.principal.id, record, mintClientOpId());
}

async function launchReserved(
  core: TerminalCore, reserved: TerminalSession, input: OpenManagedTerminalInput,
): Promise<B3Result<TerminalSession>> {
  const starting = await patchSession(core, reserved, { status: 'starting' });
  if (!starting.ok) return starting;

  const started = await core.ptyHost.start({
    workingDirectory: input.workingDirectory,
    columns: input.columns,
    rows: input.rows,
    launchAuthorityRef: input.launchAuthorityRef,
  });
  if (!started.ok) {
    await patchSession(core, starting.value, { status: 'failed' });
    return started;
  }

  // Tracked before the durable promotion, so a retry inside THIS runtime adopts
  // the process rather than being told the effect is uncertain.
  core.live.track(new LiveSession(
    starting.value.id, started.value, input.columns, input.rows, core.replayBytes,
  ));
  const live = await patchSession(core, starting.value, {
    status: 'live',
    privateProcessRef: started.value.processRef,
    openedAt: nowIsoUtc(),
  });
  if (!live.ok) {
    // The record can no longer be made to own this process, so the launch is
    // undone rather than left as an unowned PTY (red gates 25/28).
    core.live.forget(starting.value.id);
    started.value.kill();
    await patchSession(core, starting.value, { status: 'failed' });
    return live;
  }
  return live;
}

function patchSession(
  core: TerminalCore,
  session: TerminalSession,
  patch: Partial<Persisted<TerminalSession>> & { status: TerminalSession['status'] },
): Promise<B3Result<TerminalSession>> {
  return core.store.update<TerminalSession>(
    'sys_terminal', 'terminalSession', session.id,
    patch, session.recordVersion, mintClientOpId(),
  );
}

export async function viewOfSession(
  core: TerminalCore, session: TerminalSession,
): Promise<B3Result<TerminalSessionView>> {
  const attachments = await core.store.list<ControllerAttachment>(
    'controllerAttachment', { terminalSessionId: session.id },
  );
  if (!attachments.ok) return attachments;
  const active = await settleAndFindActive(core, session.id);
  if (!active.ok) return active;
  const live = core.live.lookup(session.id);
  return b3ok({
    session,
    attachments: attachments.value,
    ...(active.value === null ? {} : { activeInputLease: active.value }),
    replay: {
      earliestSequence: live?.replay.earliestSequence() ?? session.earliestReplaySequence,
      latestSequence: live?.replay.latestSequence() ?? session.outputSequence,
    },
    // The same number `writeInput` will check the next write against, so a
    // controller can arrive mid-stream and type (NVK-KIMI-025 repair 1).
    nextInputSequence: live?.nextInputSequence ?? FIRST_INPUT_SEQUENCE,
  });
}

export async function getTerminalSession(
  core: TerminalCore, _principal: AuthenticatedPrincipal, terminalSessionId: TerminalSessionId,
): Promise<B3Result<TerminalSessionView>> {
  const session = await requireSession(core, terminalSessionId);
  if (!session.ok) return session;
  return viewOfSession(core, session.value);
}

export async function listTerminalSessions(
  core: TerminalCore, _principal: AuthenticatedPrincipal, filter?: ListTerminalSessionsFilter,
): Promise<B3Result<readonly TerminalSessionView[]>> {
  const sessions = await core.store.list<TerminalSession>('terminalSession');
  if (!sessions.ok) return sessions;
  const wanted = filter?.state ?? 'all';
  const views: TerminalSessionView[] = [];
  for (const session of sessions.value) {
    const final = FINAL_STATUSES.has(session.status);
    if (wanted === 'live' && final) continue;
    if (wanted === 'final' && !final) continue;
    const view = await viewOfSession(core, session);
    if (!view.ok) return view;
    views.push(view.value);
  }
  return b3ok(views);
}

export async function terminateTerminal(
  core: TerminalCore,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: TerminateTerminalInput,
): Promise<B3Result<TerminalSession>> {
  const epoch = core.epochFence.assertActive(input.expectedRuntimeEpochId);
  if (!epoch.ok) return epoch;
  const session = await requireSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  if (FINAL_STATUSES.has(session.value.status)) return session; // already final: idempotent

  const live = core.live.lookup(session.value.id);
  live?.pty.kill();
  const closed = await closeSession(core, session.value, {
    status: 'exited',
    exitedAt: nowIsoUtc(),
    ...(live?.exit?.exitCode === undefined ? {} : { exitCode: live.exit.exitCode }),
    ...(live?.exit?.signal === undefined ? {} : { signal: live.exit.signal }),
  });
  if (closed.ok) core.live.forget(session.value.id);
  void context;
  return closed;
}

/** Final-state write plus the durable replay checkpoint. */
export async function closeSession(
  core: TerminalCore,
  session: TerminalSession,
  patch: Partial<Persisted<TerminalSession>> & { status: TerminalSession['status'] },
): Promise<B3Result<TerminalSession>> {
  const live = core.live.lookup(session.id);
  return core.store.update<TerminalSession>(
    'sys_terminal', 'terminalSession', session.id,
    {
      ...patch,
      outputSequence: live?.replay.latestSequence() ?? session.outputSequence,
      earliestReplaySequence: live?.replay.earliestSequence() ?? session.earliestReplaySequence,
    },
    session.recordVersion, mintClientOpId(),
  );
}

/**
 * Boot recovery (DEC-B3V4-23). A session recorded under a DEAD epoch cannot be
 * claimed as still running. If the recorded process is provably gone it is
 * `exited` with no exit time — absence is the honest answer, not a made-up
 * timestamp. If we cannot tell, it is `recovery-required`, never a guess.
 */
export async function reconcileAfterRestart(
  core: TerminalCore, activeRuntimeEpochId: RuntimeEpochId,
): Promise<B3Result<{ readonly reconciledSessionIds: readonly TerminalSessionId[] }>> {
  const sessions = await core.store.list<TerminalSession>('terminalSession');
  if (!sessions.ok) return sessions;
  const reconciled: TerminalSessionId[] = [];
  for (const session of sessions.value) {
    if (!needsReconciling(session, activeRuntimeEpochId)) continue;
    const settled = await settleOrphanedSession(core, session);
    if (!settled.ok) return settled;
    reconciled.push(session.id);
  }
  return b3ok({ reconciledSessionIds: reconciled });
}

/**
 * Only records that still CLAIM to be running need reconciling. A session
 * already resolved — final, or marked recovery-required by an earlier pass —
 * must not be reprocessed, or recovery never converges.
 */
function needsReconciling(
  session: TerminalSession, activeRuntimeEpochId: RuntimeEpochId,
): boolean {
  if (session.runtimeEpochId === activeRuntimeEpochId) return false;
  return CLAIMS_TO_BE_RUNNING.has(session.status);
}

async function settleOrphanedSession(
  core: TerminalCore, session: TerminalSession,
): Promise<B3Result<null>> {
  // No process ref was ever recorded, so this session never owned a process —
  // "it may still be out there" would be invented certainty (red gate 27), even
  // if a probe of some other ref would say yes.
  const neverLaunched = session.privateProcessRef === '';
  const stillThere = !neverLaunched && core.ptyHost.probe(session.privateProcessRef);
  const updated = await closeSession(core, session, {
    status: stillThere ? 'recovery-required' : (neverLaunched ? 'failed' : 'exited'),
  });
  if (!updated.ok) return updated;
  return detachAllAttachments(core, session.id);
}

export async function detachAllAttachments(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<null>> {
  const attachments = await core.store.list<ControllerAttachment>(
    'controllerAttachment', { terminalSessionId },
  );
  if (!attachments.ok) return attachments;
  for (const attachment of attachments.value) {
    if (attachment.state === 'detached') continue;
    const updated = await core.store.update<ControllerAttachment>(
      'sys_terminal', 'controllerAttachment', attachment.id,
      { state: 'detached', lastSeenAt: clockIso(core) },
      attachment.recordVersion, mintClientOpId(),
    );
    if (!updated.ok) return updated;
  }
  return b3ok(null);
}

export function terminatedByExitError(session: TerminalSession): ReturnType<typeof b3err> {
  return b3err('TerminalNotLive', `session ${session.id} already ended`,
    { terminalSessionId: session.id, status: session.status }, false);
}

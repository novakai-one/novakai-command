// Session lifecycle: open, view, list, terminate, recover.
import {
  b3fail, b3err, b3ok, mintClientOpId, mintTerminalSessionId, nowIsoUtc, validationFailed,
  type AuthenticatedPrincipal, type B3Result, type CommandContext, type IsoUtc,
  type RuntimeEpochId, type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  ListTerminalSessionsFilter, OpenManagedTerminalInput, TerminalSessionView,
  TerminateTerminalInput,
} from '../contract/api.js';
import type { ControllerAttachment, TerminalSession } from '../contract/records.js';
import { LiveSession } from './live.js';
import { settleAndFindActive } from './leases.js';
import type { Persisted } from './store.js';
import {
  CLAIMS_TO_BE_RUNNING, FINAL_STATUSES, requireSession, viewportIssues,
  type TerminalCore,
} from './context.js';

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

  const started = await core.ptyHost.start({
    workingDirectory: input.workingDirectory,
    columns: input.columns,
    rows: input.rows,
    launchAuthorityRef: input.launchAuthorityRef,
  });
  if (!started.ok) return started;

  const record: Persisted<TerminalSession> = {
    kind: 'terminalSession',
    id: mintTerminalSessionId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    owner: input.owner,
    status: 'live',
    launchFingerprint: input.launchFingerprint,
    runtimeEpochId: epoch.value,
    privateProcessRef: started.value.processRef,
    workingDirectory: input.workingDirectory,
    openedAt: nowIsoUtc(),
    outputSequence: 0,
    earliestReplaySequence: 0,
  };
  const written = await core.store.create<TerminalSession>(
    context.principal.id, record, mintClientOpId(),
  );
  if (!written.ok) {
    started.value.kill(); // never leave an unowned PTY behind (red gate 25/28)
    return written;
  }
  core.live.track(new LiveSession(
    written.value.id, started.value, input.columns, input.rows, core.replayBytes,
  ));
  return written;
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
  const stillThere = core.ptyHost.probe(session.privateProcessRef);
  const updated = await closeSession(core, session, {
    status: stillThere ? 'recovery-required' : 'exited',
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
      { state: 'detached', lastSeenAt: nowIsoUtc() as IsoUtc },
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

// Controller attachments and viewport arbitration.
//
// The rule that matters: detach is detach. It releases a held lease and it
// records that the window is gone. It never touches the process.
import {
  b3err, b3ok, mintClientOpId, mintControllerAttachmentId, nowIsoUtc, validationFailed,
  type B3Result, type CommandContext, type IsoUtc, type TerminalSessionId,
} from '@novakai/foundation/contract';
import { resolveAuthoritativeViewport } from '../contract/api.js';
import type {
  AttachControllerInput, DetachControllerInput, ResizeTerminalInput, TerminalSessionView,
} from '../contract/api.js';
import type { ControllerAttachment } from '../contract/records.js';
import { endLease, settleAndFindActive } from './leases.js';
import { viewOfSession } from './sessions.js';
import type { Persisted } from './store.js';
import {
  requireLiveSession, requireSession, viewportIssues, type TerminalCore,
} from './context.js';

export async function attachController(
  core: TerminalCore, context: CommandContext, input: AttachControllerInput,
): Promise<B3Result<ControllerAttachment>> {
  const issues = viewportIssues(input.columns, input.rows);
  if (issues.length > 0) return { ok: false, error: validationFailed(issues) };
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;

  const record: Persisted<ControllerAttachment> = {
    kind: 'controllerAttachment',
    id: mintControllerAttachmentId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    terminalSessionId: input.terminalSessionId,
    controllerKind: input.controllerKind,
    principalId: context.principal.id,
    connectedAt: nowIsoUtc(),
    lastSeenAt: nowIsoUtc(),
    focused: true,
    viewport: { columns: input.columns, rows: input.rows },
    state: 'attached',
  };
  const written = await core.store.create<ControllerAttachment>(
    context.principal.id, record, mintClientOpId(),
  );
  if (!written.ok) return written;
  // A new controller may change whose viewport wins.
  const applied = await applyAuthoritativeViewport(core, input.terminalSessionId);
  if (!applied.ok) return applied;
  return written;
}

export async function detachController(
  core: TerminalCore, context: CommandContext, input: DetachControllerInput,
): Promise<B3Result<ControllerAttachment>> {
  const attachment = await core.store.read<ControllerAttachment>(
    'controllerAttachment', input.attachmentId,
  );
  if (!attachment.ok) return attachment;
  if (attachment.value === null || attachment.value.terminalSessionId !== input.terminalSessionId) {
    return { ok: false, error: b3err('ValidationFailed',
      `attachment "${input.attachmentId}" is not on session "${input.terminalSessionId}"`,
      { issues: [{ path: 'attachmentId', message: 'unknown for this session' }] }, false) };
  }
  if (attachment.value.state === 'detached') return b3ok(attachment.value); // idempotent

  // If this controller held the lease, hand it back — but never stop the PTY.
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  if (active.value?.attachmentId === attachment.value.id) {
    const released = await endLease(core, active.value, 'released', 'released');
    if (!released.ok) return released;
  }

  const updated = await core.store.update<ControllerAttachment>(
    context.principal.id, 'controllerAttachment', attachment.value.id,
    { state: 'detached', focused: false, lastSeenAt: nowIsoUtc() as IsoUtc },
    attachment.value.recordVersion, mintClientOpId(),
  );
  if (!updated.ok) return updated;
  const applied = await applyAuthoritativeViewport(core, input.terminalSessionId);
  if (!applied.ok) return applied;
  return updated;
}

export async function resizeTerminal(
  core: TerminalCore, context: CommandContext, input: ResizeTerminalInput,
): Promise<B3Result<TerminalSessionView>> {
  const issues = viewportIssues(input.columns, input.rows);
  if (issues.length > 0) return { ok: false, error: validationFailed(issues) };
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  const attachment = await core.store.read<ControllerAttachment>(
    'controllerAttachment', input.attachmentId,
  );
  if (!attachment.ok) return attachment;
  if (attachment.value === null
    || attachment.value.terminalSessionId !== input.terminalSessionId
    || attachment.value.state !== 'attached') {
    return { ok: false, error: b3err('ValidationFailed',
      `attachment "${input.attachmentId}" is not attached to "${input.terminalSessionId}"`,
      { issues: [{ path: 'attachmentId', message: 'not an attached controller' }] }, false) };
  }

  // Every controller records ITS OWN viewport; arbitration decides whose the
  // PTY follows, so a background window can never silently reshape the shell.
  const updated = await core.store.update<ControllerAttachment>(
    context.principal.id, 'controllerAttachment', attachment.value.id,
    {
      viewport: { columns: input.columns, rows: input.rows },
      focused: true,
      lastSeenAt: nowIsoUtc() as IsoUtc,
    },
    attachment.value.recordVersion, mintClientOpId(),
  );
  if (!updated.ok) return updated;
  const applied = await applyAuthoritativeViewport(core, input.terminalSessionId);
  if (!applied.ok) return applied;
  return viewOfSession(core, session.value);
}

/**
 * DEC-B3V4-29: the lease holder's viewport is authoritative; with no holder the
 * most recently focused attached controller wins. Applied through the ONE
 * exported rule, so no surface can invent a second answer.
 */
export async function applyAuthoritativeViewport(
  core: TerminalCore, terminalSessionId: TerminalSessionId,
): Promise<B3Result<null>> {
  const session = await requireSession(core, terminalSessionId);
  if (!session.ok) return session;
  const view = await viewOfSession(core, session.value);
  if (!view.ok) return view;
  const chosen = resolveAuthoritativeViewport(view.value);
  const live = core.live.get(terminalSessionId);
  if (!chosen || !live) return b3ok(null);
  if (live.appliedViewport.columns === chosen.columns
    && live.appliedViewport.rows === chosen.rows) {
    return b3ok(null);
  }
  live.pty.resize(chosen.columns, chosen.rows);
  live.appliedViewport = { columns: chosen.columns, rows: chosen.rows };
  return b3ok(null);
}

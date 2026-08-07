// Controller presence — §13.4's `attached -> stale -> detached`.
//
// Terminal owns attachment truth, but "is that window's connection still open"
// is the Runtime host's fact, not Terminal's: the host holds the sockets. So the
// host reports who it can still see and Terminal decides what that means, the
// same shape as the active-provider-turn seam. Nothing here is a public caller
// surface, and nothing here ever touches a process.
import {
  b3ok, mintClientOpId,
  type B3Result, type ControllerAttachmentId, type IsoUtc,
} from '@novakai/foundation/contract';
import type { ControllerAttachment } from '../contract/records.js';
import type { TerminalCore } from './context.js';

export interface ObservedControllers {
  readonly staleAttachmentIds: readonly ControllerAttachmentId[];
}

/**
 * `attachmentIds` is everything the Runtime can still see. An attachment it
 * cannot see, and has not seen for longer than the stale window, is `stale` —
 * not `detached`, because nobody watched it go. `detached` is final: a window
 * that said goodbye is never resurrected by a socket that is still open.
 */
export async function observeControllers(
  core: TerminalCore, attachmentIds: readonly ControllerAttachmentId[],
): Promise<B3Result<ObservedControllers>> {
  const attachments = await core.store.list<ControllerAttachment>('controllerAttachment');
  if (!attachments.ok) return attachments;
  const visible = new Set<string>(attachmentIds);
  const nowMs = core.clock.nowMs();
  const stale: ControllerAttachmentId[] = [];

  for (const attachment of attachments.value) {
    const judged = await judgeController(core, attachment, visible.has(attachment.id), nowMs);
    if (!judged.ok) return judged;
    if (judged.value) stale.push(attachment.id);
  }
  return b3ok({ staleAttachmentIds: stale });
}

/** Is this attachment stale after this round of sightings? */
async function judgeController(
  core: TerminalCore, attachment: ControllerAttachment, visible: boolean, nowMs: number,
): Promise<B3Result<boolean>> {
  if (attachment.state === 'detached') return b3ok(false); // goodbye is final
  if (visible) {
    const seen = await recordSighting(core, attachment, nowMs);
    if (!seen.ok) return seen;
    return b3ok(false);
  }
  if (attachment.state === 'stale') return b3ok(true);
  if (nowMs - Date.parse(attachment.lastSeenAt) <= core.staleAfterMs) return b3ok(false);
  // lastSeenAt is deliberately NOT moved: when it was last seen is the fact.
  const marked = await core.store.update<ControllerAttachment>(
    'sys_terminal', 'controllerAttachment', attachment.id,
    { state: 'stale' }, attachment.recordVersion, mintClientOpId(),
  );
  if (!marked.ok) return marked;
  return b3ok(true);
}

/**
 * A sighting is worth a durable append when it changes something: a controller
 * coming back from `stale`, or a `lastSeenAt` old enough to matter. A heartbeat
 * that appends every time would put the store's growth on a timer.
 */
async function recordSighting(
  core: TerminalCore, attachment: ControllerAttachment, nowMs: number,
): Promise<B3Result<ControllerAttachment | null>> {
  const returned = attachment.state === 'stale';
  const quietFor = nowMs - Date.parse(attachment.lastSeenAt);
  if (!returned && quietFor * 2 < core.staleAfterMs) return b3ok(null);
  return core.store.update<ControllerAttachment>(
    'sys_terminal', 'controllerAttachment', attachment.id,
    { state: 'attached', lastSeenAt: new Date(nowMs).toISOString() as IsoUtc },
    attachment.recordVersion, mintClientOpId(),
  );
}

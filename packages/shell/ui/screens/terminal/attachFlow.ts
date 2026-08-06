// Joining a session: attach, adopt its position, write its history, then draw
// what arrived while that was happening — in that order.
//
// The third file in this folder that exists because the ORDER is the dangerous
// part (bootFlow.ts, tabCloseFlow.ts). Here the order is what keeps history from
// being drawn twice: the window must start HOLDING live frames before it asks
// for the backlog, or the frames that land in between are either drawn twice or
// lost, depending on which answer wins the race (contract/terminalReplay.ts).
import type { Terminal } from '@xterm/xterm';
import { framesAfterReplay } from '../../../contract/terminalReplay.js';
import type { TerminalAttachment, TerminalFrame } from '../../../contract/terminalServices.js';
import type { TerminalViewport } from '../../../contract/terminalViewport.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';
import { writeReplay } from './session.js';

export interface AttachWiring {
  readonly services: TerminalConnection;
  readonly terminalSessionId: string;
  /** Measured, never guessed — this is set on the pty (contract/terminalViewport.ts). */
  readonly viewport: TerminalViewport;
  readonly screen: Terminal;
  /** Still this window's business? A switch away abandons the rest. */
  readonly alive: () => boolean;
  /**
   * The window's own bookkeeping, handed over as refs — the same shape
   * `makeRawInputHandler` takes, and for the same reason: these are read at
   * frame time by a listener registered once, so a captured copy would be the
   * previous tab's.
   */
  readonly refs: {
    readonly attachment: { current: TerminalAttachment | null };
    readonly attachedTo: { current: string | null };
    readonly inputSequence: { current: number };
    readonly heldFrames: { current: TerminalFrame[] | null };
  };
  /** Told when this window may only watch: someone else holds the input lease. */
  readonly onWatchingOnly: () => void;
  readonly draw: (frame: TerminalFrame) => void;
}

export type AttachOutcome =
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | { readonly kind: 'abandoned' }
  | { readonly kind: 'attached'; readonly mark: number };

export async function attachAndReplay(wiring: AttachWiring): Promise<AttachOutcome> {
  const { services, terminalSessionId, screen } = wiring;
  const joined = await services.attach(
    terminalSessionId, wiring.viewport.columns, wiring.viewport.rows,
  );
  if (!wiring.alive()) return { kind: 'abandoned' };
  if (!joined.succeeded) {
    return { kind: 'refused', code: joined.code, message: joined.message };
  }
  const { refs } = wiring;
  refs.attachment.current = joined.value;
  refs.attachedTo.current = terminalSessionId;
  // This window has typed nothing; the session may have been typed into for an
  // hour. The Runtime's position is adopted, never assumed to be 1 — assuming it
  // is what made a reopened window read-only (NVK-KIMI-025).
  refs.inputSequence.current = joined.value.nextInputSequence;
  if (joined.value.leaseId === '') wiring.onWatchingOnly();

  // Whatever happened while nobody was watching is shown before live output. The
  // mark it answers with is how the Runtime's own catch-up — the same backlog,
  // pushed to every new subscriber — is told apart from output that is new.
  const mark = await writeReplay(services, terminalSessionId, screen);
  const waiting = refs.heldFrames.current ?? [];
  refs.heldFrames.current = null;
  for (const frame of framesAfterReplay(waiting, mark)) wiring.draw(frame);
  return { kind: 'attached', mark };
}

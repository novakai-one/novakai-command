// History is written once.
//
// A window that attaches is caught up on the session's output twice: the
// Runtime's follower pushes the backlog to every new subscriber, and the Shell
// reads the same frames back with `b3.terminal.read` and writes them itself.
// Which copy the screen shows was a race, so the boot banner appeared once or
// twice depending on how fast the host answered.
//
// The Runtime numbers its frames, so this needs no bookkeeping of its own: the
// replay reports how far it got, and anything at or before that mark is history
// arriving a second time.
import type { TerminalFrame } from './terminalServices.js';

/** The mark a session starts from: nothing has been replayed. */
export const NOTHING_REPLAYED = 0;

/**
 * How far the replay actually wrote. A `gap` frame is drawn as a stated gap but
 * carries none of the session's bytes, so it never counts as progress — taking
 * it as progress would drop the live frames that fill the hole.
 */
export function replayedThrough(frames: readonly TerminalFrame[]): number {
  let mark = NOTHING_REPLAYED;
  for (const frame of frames) {
    if (frame.kind === 'gap') continue;
    if (frame.sequence !== undefined && frame.sequence > mark) mark = frame.sequence;
  }
  return mark;
}

/**
 * Whether a live frame is new output rather than history arriving again.
 *
 * An unnumbered frame is DRAWN. It cannot be matched against history, and the
 * failure modes are not symmetric: drawing history twice is untidy, while
 * dropping live output makes a working process look like a dead one — which is
 * the same reason Calm releases a trailing partial line rather than holding it.
 */
export function acceptOutputFrame(
  frame: Pick<TerminalFrame, 'kind' | 'sequence'>, mark: number,
): boolean {
  if (frame.sequence === undefined) return true;
  return frame.sequence > mark;
}

/**
 * What to draw of the output that arrived WHILE history was being written.
 *
 * The mark cannot be known until the replay has answered, so live frames that
 * land in between can be neither drawn (the replay may be about to write them
 * again) nor dropped (the replay may have been read before they existed). They
 * are held, and this decides them once the mark exists — in arrival order, since
 * a terminal that reorders its own output is worse than one that repeats it.
 */
export function framesAfterReplay(
  buffered: readonly TerminalFrame[], mark: number,
): readonly TerminalFrame[] {
  return buffered.filter((frame) => acceptOutputFrame(frame, mark));
}

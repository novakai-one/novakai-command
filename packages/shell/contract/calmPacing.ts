// shell/contract/calmPacing.ts — what `TerminalTabRecord.mode` actually MEANS.
//
// FZ-VIEW-017 freezes Calm's pacing INPUTS (`maxBufferedLines`,
// `revealLinesPerSecond`); how Calm paces is builder freedom (P-20). This file
// is that freedom exercised once, in one place, as pure data-in/data-out — no
// xterm, no timers, no clock. The screen owns the tick; this owns the rule. A
// pacing rule that only exists inside a React effect is a rule that cannot be
// tested, and a terminal is the last surface where "probably fine" is fine.
//
// It exists because since B1.1 the record has carried `mode: 'raw' | 'calm'`
// and a validated `calmPacing`, and NOTHING READ THEM: a tab stored as Calm
// behaved byte-for-byte like a Raw one.
//
// Four laws, in the order breaking them would hurt:
//
//   1. RAW IS IDENTITY. Every byte, immediately, in order (`rawPassthrough` is
//      the whole implementation, and it is a named function so the Calm
//      machinery has no way to reach the Raw path).
//   2. A TERMINAL THAT IS FINE MUST NEVER LOOK HUNG. Shell prompts carry no
//      newline, so a queue that holds partial lines until they complete holds
//      every prompt forever — and a working pacer becomes indistinguishable
//      from a dead process. The trailing partial is released once the queue has
//      DRAINED, and not before (releasing it early would print the prompt above
//      the output it belongs under).
//   3. DROPPED OUTPUT IS ANNOUNCED. `maxBufferedLines` is a ceiling, so Calm
//      CAN lose output. Losing it silently is the false empty in a terminal's
//      clothes — the same law `writeReplay`'s gap marker already obeys.
//   4. ASKING FOR THE TRUTH GIVES IT TO YOU NOW. Switching to Raw flushes
//      everything held in one go.
//
// KNOWN AND ACCEPTED LIMITATION, stated rather than discovered later: dropping
// whole lines can discard ANSI sequences that set terminal state (colour,
// cursor position), so a Calm tab that has overflowed may render later output
// with the wrong attributes. That is a real cost of pacing a byte stream by
// line, it is one more reason Raw is the default and the truth mode, and the
// gap marker is what tells Chris he is looking at a tab that has dropped
// something.

/** The frozen pacing inputs, as the record carries them. */
export interface CalmPacing {
  readonly maxBufferedLines: number;
  readonly revealLinesPerSecond: number;
}

/**
 * Everything Calm remembers. A value, never mutated — every function here
 * returns a new one, so a render that runs twice cannot double-advance the
 * stream.
 */
export interface CalmState {
  /** Complete lines waiting, oldest first, newline included. */
  readonly pending: readonly string[];
  /** Bytes since the last newline. Not a line yet, and maybe never will be. */
  readonly partial: string;
  /** Lines lost to the ceiling and not yet announced. */
  readonly dropped: number;
  /** When the reveal clock was last advanced (ms). */
  readonly revealedAt: number;
  /**
   * Time earned but not yet spent, in MILLISECONDS.
   *
   * Two bugs live here and the units are how both are avoided. Without any
   * carry, a 1 line/second tab against a 100ms tick earns 0.1 lines, floors to
   * zero, and reveals NOTHING — forever, at any rate below one line per tick.
   * Carrying FRACTIONAL LINES instead fixes that and then fails the same way
   * for a different reason: ten additions of 0.1 come to 0.9999999999999999,
   * which floors to zero, so the tab still starves — just less obviously, and
   * only at some rates. Milliseconds accumulate as integers, so the tenth tick
   * is exactly the second and the line comes out.
   */
  readonly creditMs: number;
}

export function emptyCalmState(nowMs: number): CalmState {
  return { pending: [], partial: '', dropped: 0, revealedAt: nowMs, creditMs: 0 };
}

/** LAW 1. Raw is the identity function, and is named so it stays that way. */
export function rawPassthrough(text: string): string {
  return text;
}

/**
 * Take a chunk off the session.
 *
 * Splits on newline and keeps the tail as `partial`. When the queue is over its
 * ceiling the OLDEST lines go: a terminal shows you the recent past, and
 * dropping the newest would mean the live tail never arrives — the tab would
 * freeze on old output while the process ran on.
 */
export function receiveCalm(
  state: CalmState, text: string, pacing: CalmPacing,
): CalmState {
  if (text === '') return state;
  const parts = (state.partial + text).split('\n');
  // The last part is whatever follows the final newline — '' when the chunk
  // ended cleanly, a partial line otherwise.
  const partial = parts.pop() ?? '';
  const arrived = parts.map((line) => `${line}\n`);
  const queued = [...state.pending, ...arrived];
  const ceiling = Math.max(1, pacing.maxBufferedLines);
  if (queued.length <= ceiling) {
    return { ...state, pending: queued, partial };
  }
  const lost = queued.length - ceiling;
  return {
    ...state,
    pending: queued.slice(lost),
    partial,
    dropped: state.dropped + lost,
  };
}

/** LAW 3. Said in the stream itself, where the missing output would have been. */
function gapMarker(count: number): string {
  return `\r\n[${count} line${count === 1 ? '' : 's'} not shown — `
    + 'this tab is buffering at its limit]\r\n';
}

/**
 * What is releasable as of `now`, and the engine advanced past it.
 *
 * Returns `text` for the screen to write and the next state. The gap marker, if
 * one is owed, leads — it belongs where the lost output was, not appended after
 * the lines that replaced it.
 */
export function revealCalm(
  state: CalmState, nowMs: number, pacing: CalmPacing,
): { readonly state: CalmState; readonly text: string } {
  const elapsed = Math.max(0, nowMs - state.revealedAt);
  const rate = Math.max(0, pacing.revealLinesPerSecond);
  const banked = state.creditMs + elapsed;
  const allowed = rate === 0 ? 0 : Math.floor((banked * rate) / 1_000);
  // Only the time that actually bought a line is spent; the rest stays banked.
  const creditMs = rate === 0 ? banked : banked - (allowed * 1_000) / rate;

  const releasing = state.pending.slice(0, allowed);
  const remaining = state.pending.slice(releasing.length);

  // LAW 2: the trailing partial goes out only once the whole queue has drained.
  // A prompt held behind a backlog is correct; a prompt held behind nothing is
  // a terminal that looks dead while it is fine.
  const drained = remaining.length === 0;
  const partial = drained ? '' : state.partial;
  const tail = drained ? state.partial : '';

  const announced = state.dropped > 0 && releasing.length > 0;
  const body = releasing.join('') + tail;
  return {
    state: {
      pending: remaining,
      partial,
      dropped: announced ? 0 : state.dropped,
      revealedAt: nowMs,
      creditMs,
    },
    text: (announced ? gapMarker(state.dropped) : '') + body,
  };
}

/**
 * LAW 4. Everything held, at once, in order — the switch to Raw, and the only
 * place the rate does not apply. Any gap still owed is announced here too: a
 * flush is not an amnesty for output that was lost.
 */
export function flushCalm(
  state: CalmState,
): { readonly state: CalmState; readonly text: string } {
  const held = state.pending.join('') + state.partial;
  const marker = state.dropped > 0 ? gapMarker(state.dropped) : '';
  return {
    state: { ...state, pending: [], partial: '', dropped: 0, creditMs: 0 },
    text: marker + held,
  };
}

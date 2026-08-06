// shell/ui/screens/terminal/session.ts — the terminal screen's pure helpers.
//
// Split out of TerminalScreen because none of them is React: they take a
// connection and give back a value, so they are readable and testable without
// mounting anything, and the controller is left with only the parts that
// genuinely need an effect. (It also keeps the screen under the 300-line
// ceiling the lint gate enforces, which is the same pressure pointing the same
// way.)
import { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import {
  flushCalm, rawPassthrough, receiveCalm, revealCalm,
  type CalmPacing, type CalmState,
} from '../../../contract/calmPacing.js';
import { replayedThrough } from '../../../contract/terminalReplay.js';
import type { TerminalFrame } from '../../../contract/terminalServices.js';
import {
  readViewport, viewportChanged, type TerminalViewport,
} from '../../../contract/terminalViewport.js';
import type { TerminalConnection } from '../../../app/terminalClient.js';

/**
 * xterm paints its own pixels, so it is handed the kit's tokens rather than a
 * second palette (§16: one token source). No gold: the composed viewport's one
 * attention signal belongs to the rail, and a cursor is not an exception.
 */
export function xtermTheme(): { background: string; foreground: string; cursor: string } {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string =>
    tokens.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--workspace', '#1b1b1e'),
    foreground: token('--ink', '#ececee'),
    cursor: token('--ink-2', '#b4b4bb'),
  };
}

/**
 * Write the session's history, and answer HOW FAR it got.
 *
 * The mark matters: the Runtime also pushes this same history to every new
 * subscriber, so without it the live stream draws the backlog a second time
 * (contract/terminalReplay.ts). A refused read has replayed nothing, which is
 * the honest mark rather than a hopeful one — everything then draws live.
 */
export async function writeReplay(
  services: TerminalConnection, sessionId: string, screen: Terminal,
): Promise<number> {
  const replay = await services.readReplay(sessionId, 0);
  if (!replay.succeeded) return 0;
  for (const frame of replay.value) {
    // A gap is stated, never papered over with whatever bytes remain.
    screen.write(frame.kind === 'gap' ? '\r\n[earlier output is no longer buffered]\r\n' : frame.text);
  }
  return replayedThrough(replay.value);
}

/**
 * Keep the terminal's size honest, and say when it changes.
 *
 * `proposeDimensions()` rather than `fit()`: fit applies the addon's own floor
 * when it cannot measure, which is indistinguishable from a genuinely tiny
 * terminal — and B1.5 watched that floor become a real 2-column pty, whose
 * mangled prompt is now permanent in that session's replay. The proposal can be
 * refused; the floor cannot.
 *
 * A ResizeObserver rather than a window listener: the surface changes size when
 * the LAYOUT does, not only when the window does — and the first measurement is
 * exactly the case a window listener never fires for.
 */
export function watchViewport(wiring: {
  readonly surface: HTMLElement | null;
  readonly screen: Terminal;
  readonly fitAddon: FitAddon;
  /** The last accepted measurement, owned by the caller so it survives renders. */
  readonly current: () => TerminalViewport | null;
  readonly onMeasured: (viewport: TerminalViewport) => void;
}): () => void {
  const measure = (): void => {
    const decided = readViewport(wiring.fitAddon.proposeDimensions());
    if (!decided.known) return;
    const next: TerminalViewport = { columns: decided.columns, rows: decided.rows };
    if (!viewportChanged(wiring.current(), next)) return;
    wiring.screen.resize(next.columns, next.rows);
    wiring.onMeasured(next);
  };
  const watcher = new ResizeObserver(() => { measure(); });
  if (wiring.surface) watcher.observe(wiring.surface);
  measure();
  return () => watcher.disconnect();
}

/**
 * The one place a frame becomes pixels.
 *
 * One writer, deliberately: frames reach the screen live AND as the flush of
 * what arrived while history was being written (B1.5), and a second write path
 * would be a second answer to "what does Calm do with this". The two would drift
 * on the first change to either.
 */
export function makeFrameWriter(wiring: {
  readonly screen: Terminal;
  readonly calm: { current: CalmState };
  readonly pace: { current: { mode: 'raw' | 'calm'; pacing: CalmPacing } };
  readonly onExit: () => void;
}): (frame: TerminalFrame) => void {
  return (frame) => {
    if (frame.kind === 'exit') {
      // The exit notice is the Shell's own, not the session's bytes, and it is
      // never paced: "this ended" held behind a backlog is the one message that
      // must not arrive late.
      const { state, text } = flushCalm(wiring.calm.current);
      wiring.calm.current = state;
      wiring.screen.write(`${text}\r\n[the terminal exited]\r\n`);
      wiring.onExit();
      return;
    }
    if (wiring.pace.current.mode === 'raw') {
      wiring.screen.write(rawPassthrough(frame.text));
      return;
    }
    wiring.calm.current = receiveCalm(
      wiring.calm.current, frame.text, wiring.pace.current.pacing,
    );
  };
}

/**
 * Calm's clock. Raw never reaches it, and a tick that releases nothing writes
 * nothing — an empty write would still cost xterm a render.
 */
export function startCalmClock(wiring: {
  readonly screen: Terminal;
  readonly calm: { current: CalmState };
  readonly pace: { current: { mode: 'raw' | 'calm'; pacing: CalmPacing } };
  readonly stopped: () => boolean;
  readonly clock: () => number;
}): () => void {
  const ticking = setInterval(() => {
    if (wiring.stopped() || wiring.pace.current.mode !== 'calm') return;
    const { state, text } = revealCalm(wiring.calm.current, wiring.clock(), wiring.pace.current.pacing);
    wiring.calm.current = state;
    if (text !== '') wiring.screen.write(text);
  }, 16);
  return () => clearInterval(ticking);
}

// What size the terminal actually is — and when the Shell is allowed to say.
//
// This exists because a terminal viewport is not a display detail: it is handed
// to the Runtime, which sets it on a real pty, and the process on the other end
// reformats itself around it. A guessed size is therefore a WRITE to somebody
// else's process, and an unmeasured one is a write of a number nobody has ever
// seen on screen.
//
// The fit addon cannot express "I could not measure": `fit()` substitutes its
// own floor and applies it. So the Shell asks for the PROPOSAL and decides here,
// where "not measured" is a value rather than a silently plausible 2x1.
//
// Pure. No xterm, no element, no browser global — the caller does the measuring
// and this decides what the measurement is worth.

/** What `FitAddon.proposeDimensions()` answers: cell counts, or nothing. */
export interface ProposedDimensions {
  readonly cols: number;
  readonly rows: number;
}

/**
 * The addon's own minimum, and therefore the reading an element with no layout
 * box produces. Named rather than inlined: this constant IS the defect B1.5
 * found, and a test that says `2` says nothing about why.
 */
export const XTERM_FIT_FLOOR: ProposedDimensions = { cols: 2, rows: 1 };

export interface TerminalViewport {
  readonly columns: number;
  readonly rows: number;
}

export type MeasuredViewport =
  | { readonly known: true; readonly columns: number; readonly rows: number }
  | { readonly known: false };

const UNKNOWN: MeasuredViewport = { known: false };

function wholeCells(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * A proposal is a viewport only when it could actually have come from a laid-out
 * surface. At or below the addon's floor it could not have, so it is refused —
 * including the case where the surface really is that small, because a two-column
 * terminal is not something the Shell should be resizing a live process to
 * either.
 */
export function readViewport(proposed: ProposedDimensions | undefined): MeasuredViewport {
  if (!proposed) return UNKNOWN;
  const { cols, rows } = proposed;
  if (!wholeCells(cols) || !wholeCells(rows)) return UNKNOWN;
  if (cols <= XTERM_FIT_FLOOR.cols || rows <= XTERM_FIT_FLOOR.rows) return UNKNOWN;
  return { known: true, columns: cols, rows };
}

/**
 * Whether the Runtime has to be told. Every resize signals the process, which
 * redraws its prompt into the session's permanent output history — so a size
 * pushed on every measurement rather than on every CHANGE writes noise into the
 * record of what the terminal did.
 */
export function viewportChanged(
  current: TerminalViewport | null, next: TerminalViewport,
): boolean {
  if (current === null) return true;
  return current.columns !== next.columns || current.rows !== next.rows;
}

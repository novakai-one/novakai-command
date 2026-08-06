// B1.5, found in a browser against a REAL backed host: the terminal opened its
// PTY at TWO COLUMNS.
//
// `fitAddon.fit()` ran synchronously inside the mount effect, before the browser
// had laid the surface out. With no layout box the addon has nothing to measure,
// so it falls back to its own floor — and the Shell handed that floor to the
// Runtime as the viewport. The shell process then wrapped its prompt every two
// characters, and on the next resize readline walked the cursor up sixteen lines
// to redraw it. Verified first-hand on the wire (NVK-KIMI-091 seat 11):
//
//   opened 2x1  → "\r\x1b[K(ba\rase\re) \r Ma…" + 16×"\x1b[A"   ← garbage
//   opened 178x46 → "(base) Mac:tmp christopherdasca$ "          ← clean
//
// Those bytes are written into the session's PERMANENT output history, so every
// later attach replays them: one unmeasured read at boot corrupts the terminal
// for the rest of the session's life. No offline test could see it — the mock
// services spawn no process, so the geometry went nowhere.
//
// The law: a size the Shell has not actually measured is NOT a viewport. It is
// the same law this lane has been enforcing all along (unavailable is not zero),
// arriving on the one surface where guessing writes to another process.
import { describe, it, expect } from 'vitest';
import {
  XTERM_FIT_FLOOR, readViewport, viewportChanged,
} from '../contract/terminalViewport.js';

describe('what counts as a measured viewport', () => {
  it('a real measurement is a viewport', () => {
    expect(readViewport({ cols: 178, rows: 46 })).toEqual({
      known: true, columns: 178, rows: 46,
    });
  });

  it('nothing measured is UNKNOWN, never a default', () => {
    // proposeDimensions() answers undefined when it cannot measure. The old code
    // used fit(), which silently substitutes the floor for exactly this case.
    expect(readViewport(undefined)).toEqual({ known: false });
  });

  it('the addon floor is UNKNOWN — it is what an unlaid-out element yields', () => {
    expect(readViewport(XTERM_FIT_FLOOR)).toEqual({ known: false });
    expect(readViewport({ cols: 2, rows: 1 })).toEqual({ known: false });
  });

  it('a single column or row is not a terminal anyone is looking at', () => {
    expect(readViewport({ cols: 1, rows: 46 })).toEqual({ known: false });
    expect(readViewport({ cols: 178, rows: 0 })).toEqual({ known: false });
  });

  it('refuses a measurement that is not a whole positive number of cells', () => {
    expect(readViewport({ cols: Number.NaN, rows: 46 })).toEqual({ known: false });
    expect(readViewport({ cols: 178, rows: Number.POSITIVE_INFINITY })).toEqual({ known: false });
    expect(readViewport({ cols: 178.5, rows: 46 })).toEqual({ known: false });
  });
});

describe('when the Runtime is told about a size change', () => {
  // Every resize SIGWINCHes the process and puts a prompt redraw in the
  // session's permanent history. Seat 11 watched a single page load resize the
  // live PTY twice (182x47 → 178x46) because the size was pushed on every
  // measurement rather than on every CHANGE.
  it('an unchanged measurement is not a change', () => {
    expect(viewportChanged({ columns: 178, rows: 46 }, { columns: 178, rows: 46 })).toBe(false);
  });

  it('a first measurement is a change', () => {
    expect(viewportChanged(null, { columns: 178, rows: 46 })).toBe(true);
  });

  it('a different width or height is a change', () => {
    expect(viewportChanged({ columns: 178, rows: 46 }, { columns: 182, rows: 46 })).toBe(true);
    expect(viewportChanged({ columns: 178, rows: 46 }, { columns: 178, rows: 47 })).toBe(true);
  });
});

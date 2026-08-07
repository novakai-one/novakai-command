// NVK-KIMI-091 B3.3 — the keyboard half of a modal.
//
// `aria-modal="true"` is a CLAIM, and until now the close dialog made it and
// broke it: Escape cancelled and the primary took focus (both browse-proven in
// B1.6), but Tab walked straight out of the dialog into the tab strip, the mode
// toggle and Close window behind it. A screen reader is told the rest of the
// page is inert while the keyboard proves it is not — and the control the next
// Return would press is one Chris cannot see, because the dialog is over it.
//
// B3.2 made that worse in the one way that matters: the controls behind the
// dialog now sit above a live stop. Tabbing out and pressing Return is no longer
// "something odd happened", it is an unintended press on a surface whose whole
// job is to make stopping a process deliberate.
//
// The DECISION is pure and lives here. Whether the browser's own Tab would stay
// inside the dialog is arithmetic over (how many controls, which one has focus,
// which direction) — so it is tested without a DOM, and the component is left
// with nothing but "find the controls, move the focus".
import { describe, expect, it } from 'vitest';
import { trapFocus } from '../contract/focusTrap.js';

describe('trapFocus — where Tab must land so focus never leaves', () => {
  it('lets the browser do it when the move stays inside', () => {
    // Nothing to correct: `null` means "do not preventDefault", which keeps the
    // native focus order (and every native affordance that rides on it) intact.
    expect(trapFocus({ count: 3, current: 0, backwards: false })).toBeNull();
    expect(trapFocus({ count: 3, current: 1, backwards: false })).toBeNull();
    expect(trapFocus({ count: 3, current: 2, backwards: true })).toBeNull();
    expect(trapFocus({ count: 3, current: 1, backwards: true })).toBeNull();
  });

  it('wraps forward off the last control to the first', () => {
    expect(trapFocus({ count: 3, current: 2, backwards: false })).toBe(0);
  });

  it('wraps backward off the first control to the last', () => {
    expect(trapFocus({ count: 3, current: 0, backwards: true })).toBe(2);
  });

  it('pulls focus back in when it is already outside — in both directions', () => {
    // The dialog can open with focus elsewhere: `autoFocus` is a request, and a
    // browser that has not granted it yet leaves `current` at -1. Tab then has
    // to ARRIVE somewhere inside rather than continue the page's own order.
    expect(trapFocus({ count: 3, current: -1, backwards: false })).toBe(0);
    expect(trapFocus({ count: 3, current: -1, backwards: true })).toBe(2);
  });

  it('does nothing at all with no controls to hold', () => {
    // A dialog with nothing focusable cannot trap anything, and a trap that
    // swallowed Tab here would be a keyboard dead end with no way out.
    expect(trapFocus({ count: 0, current: -1, backwards: false })).toBeNull();
    expect(trapFocus({ count: 0, current: -1, backwards: true })).toBeNull();
  });

  it('holds a lone control against both directions', () => {
    // One button: every Tab is a wrap onto itself. It must still preventDefault,
    // or the single-choice dialog is the one that leaks.
    expect(trapFocus({ count: 1, current: 0, backwards: false })).toBe(0);
    expect(trapFocus({ count: 1, current: 0, backwards: true })).toBe(0);
  });
});

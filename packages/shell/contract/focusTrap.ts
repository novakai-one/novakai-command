// shell/contract/focusTrap.ts — where Tab must land so focus never leaves a
// modal that has claimed `aria-modal="true"`.
//
// Pure: no DOM, no React, no element list. It is handed how many controls the
// dialog holds, which one has focus, and which way Tab is going, and answers with
// the index that must receive focus — or `null` for "the browser's own move is
// already correct, leave it alone".
//
// That last case is the reason this is a decision and not a loop. A trap that
// preventDefaults EVERY Tab and re-implements the whole order gets the ordinary
// moves wrong sooner or later (a control that grows a second tab stop, a browser
// that skips a disabled one), and it does so silently. Correcting only the two
// moves that would actually leave keeps native focus order — and everything that
// rides on it — intact for every other press.
export interface FocusTrapQuestion {
  /** How many focusable controls the dialog holds. */
  readonly count: number;
  /** Which of them has focus, or `-1` when focus is outside the dialog. */
  readonly current: number;
  /** Shift is held. */
  readonly backwards: boolean;
}

export function trapFocus(question: FocusTrapQuestion): number | null {
  const { count, current, backwards } = question;
  // Nothing focusable: a trap here would swallow Tab and leave the keyboard in a
  // dead end with no way out — worse than the leak it was meant to close.
  if (count <= 0) return null;
  // Focus is outside already (a dialog whose `autoFocus` request has not been
  // granted yet). Tab must ARRIVE inside rather than continue the page's order.
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  if (!backwards && current === count - 1) return 0;
  if (backwards && current === 0) return count - 1;
  return null;
}

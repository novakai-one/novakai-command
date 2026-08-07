// The writes that change how a tab READS: its mode, and Calm's two numbers
// (FZ-VIEW-017).
//
// One flow, because both writes have the same three obligations and getting any
// of them in only one place is how the two controls drift apart:
//
//   1. THE RECORD IS WHERE IT LIVES. A mode or a rate held only in component
//      state is one that quietly reverts on reload.
//   2. THE REF MOVES FIRST. `paceRef` is what the single output listener reads,
//      so it is set before the awaited write — a frame arriving in between is
//      already paced the way Chris just asked for.
//   3. NOTHING HELD IS STRANDED. Leaving Calm flushes what it holds; output
//      sitting in a buffer nobody will read again is output the process printed
//      and Chris never saw.
//
// It owns no tabs. The screen is handed the saved record and decides what the
// strip shows, exactly as it does for every other write.
import { useCallback } from 'react';
import {
  emptyCalmState, flushCalm, type CalmPacing, type CalmState,
} from '../../../contract/calmPacing.js';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { TerminalTabRecord } from '../../../contract/terminalTab.js';

export interface TabPacingWiring {
  readonly tabs: ShellTerminalTabServices;
  readonly selectedTabId: string | null;
  /** Calm's memory and the rule the output listener reads — both live refs. */
  readonly calm: { current: CalmState };
  readonly pace: { current: { mode: 'raw' | 'calm'; pacing: CalmPacing } };
  /** Straight into xterm: a flush is written, never queued. */
  readonly write: (text: string) => void;
  readonly onSaved: (record: TerminalTabRecord) => void;
  readonly onProblem: (message: string) => void;
  /** Injected so the flush is testable without a clock. */
  readonly clock: () => number;
}

export interface TabPacingFlow {
  readonly changeMode: (mode: 'raw' | 'calm') => Promise<void>;
  readonly changePacing: (pacing: CalmPacing) => Promise<void>;
}

export function useTabPacing(wiring: TabPacingWiring): TabPacingFlow {
  const { tabs, selectedTabId, calm, pace, write, onSaved, onProblem, clock } = wiring;

  const changeMode = useCallback(async (next: 'raw' | 'calm') => {
    if (selectedTabId === null) return;
    if (next === 'raw') {
      const { state, text } = flushCalm(calm.current);
      calm.current = state;
      if (text !== '') write(text);
    } else {
      calm.current = emptyCalmState(clock());
    }
    pace.current = { ...pace.current, mode: next };
    const saved = await tabs.save(selectedTabId, { mode: next }, mintShellOpId());
    if (!saved.ok) {
      onProblem(`${saved.error.code}: ${saved.error.message}`);
      return;
    }
    onSaved(saved.value.record);
  }, [selectedTabId, tabs, calm, pace, write, onSaved, onProblem, clock]);

  /**
   * Calm's two numbers.
   *
   * The value is NOT clamped here. `CALM_PACING_LIMITS` bounds the picker and the
   * same constant bounds the record's schema, so an out-of-range value is a
   * refusal Chris is shown — not a number silently changed under him, which is
   * how a control starts disagreeing with the thing it controls.
   *
   * A rate change takes effect on the next tick with no flush: the queue is
   * still the truth, it just drains at a different speed. Dropping the buffer
   * here would discard output Chris has not read yet, which is the one thing
   * `maxBufferedLines` exists to be honest about.
   */
  const changePacing = useCallback(async (pacing: CalmPacing) => {
    if (selectedTabId === null) return;
    pace.current = { ...pace.current, pacing };
    const saved = await tabs.save(selectedTabId, { calmPacing: pacing }, mintShellOpId());
    if (!saved.ok) {
      onProblem(`${saved.error.code}: ${saved.error.message}`);
      return;
    }
    onSaved(saved.value.record);
  }, [selectedTabId, tabs, pace, onSaved, onProblem]);

  return { changeMode, changePacing };
}

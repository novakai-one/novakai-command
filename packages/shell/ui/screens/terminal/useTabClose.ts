// Closing a window, as one unit: the press, the question, the answer, and the
// one sentence the Shell is entitled to say afterwards (FZ-VIEW-033).
//
// It lives beside the screen rather than inside it because closing is a flow with
// its own state — a question in flight and a claim just made — and because
// `TerminalScreen` has a real line ceiling that a flow this size does not belong
// under. The DECISION is pure and lives in contract/terminalClose.ts; the ORDER
// of effects lives in tabCloseFlow.ts; this is the React binding between them and
// is deliberately nothing else. Two useStates, and every question it can answer
// is answered somewhere a test can reach without a browser.
//
// It does not own tabs. The screen still owns which tabs exist and which is
// selected, and is told when one has gone — otherwise there would be two places
// deciding what is open, which is the same drift the strip's own join avoids.
import { useCallback, useState } from 'react';
import {
  decideTabClose, SHELL_STOP_DOORS, stopSubjectOf,
  type TabCloseChoiceId, type TabCloseClaim, type TabCloseDecision,
} from '../../../contract/terminalClose.js';
import { runTabClose, type TabCloseWiring } from './tabCloseFlow.js';
import type { TabSessionTruth } from '../../../contract/terminalTabStrip.js';

export type { HeldAttachment, TabCloseWiring } from './tabCloseFlow.js';

export interface TabCloseFlow {
  /** The question in flight, with the tab it is about, or `null`. */
  readonly asking: {
    readonly tabId: string;
    /** The Run a stop would be aimed at, decided at PRESS time with the rest. */
    readonly subject: string | null;
    readonly decision: Extract<TabCloseDecision, { mustAsk: true }>;
  } | null;
  /** The last thing said about a closed session — the screen draws it. */
  readonly closedNote: string | null;
  readonly requestClose: (tabId: string | null, session: TabSessionTruth) => void;
  readonly answer: (choice: TabCloseChoiceId) => void;
  readonly forgetNote: () => void;
}

export function useTabClose(wiring: TabCloseWiring): TabCloseFlow {
  const [asking, setAsking] = useState<TabCloseFlow['asking']>(null);
  const [closedNote, setClosedNote] = useState<string | null>(null);
  const { tabs, agentRuns, held, detach, onClosed, onProblem } = wiring;

  const apply = useCallback(async (
    tabId: string, choice: TabCloseChoiceId, claim: TabCloseClaim, subject: string | null,
  ) => {
    setAsking(null);
    // `null` means the window did NOT close — a refused stop, or a cancel. The
    // note is left exactly as it was rather than replaced with a sentence about
    // a close that never happened.
    const note = await runTabClose(
      { tabs, agentRuns, held, detach, onClosed, onProblem },
      { tabId, choice, claim, subject },
    );
    if (note !== null) setClosedNote(note);
  }, [tabs, agentRuns, held, detach, onClosed, onProblem]);

  /**
   * The press. It asks ONLY when the session is live, exactly as the row is
   * written — and remembers which tab was selected at press time, so a strip that
   * moves underneath the question cannot close the wrong window.
   */
  const requestClose = useCallback((tabId: string | null, session: TabSessionTruth) => {
    if (tabId === null) return;
    const decision = decideTabClose(session, SHELL_STOP_DOORS);
    if (decision.mustAsk) {
      // The subject is captured with the question. A strip that moves while the
      // dialog is open must not re-point the stop at whatever is selected now.
      setAsking({ tabId, subject: stopSubjectOf(session), decision });
      return;
    }
    void apply(tabId, 'keep-running', decision.claim, null);
  }, [apply]);

  const answer = useCallback((choice: TabCloseChoiceId) => {
    if (asking === null) return;
    if (choice === 'cancel') {
      setAsking(null);
      return;
    }
    void apply(asking.tabId, choice, asking.decision.claim, asking.subject);
  }, [asking, apply]);

  return {
    asking,
    closedNote,
    requestClose,
    answer,
    forgetNote: useCallback(() => setClosedNote(null), []),
  };
}

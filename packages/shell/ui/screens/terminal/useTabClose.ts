// Closing a window, as one unit: the press, the question, the answer, and the
// one sentence the Shell is entitled to say afterwards (FZ-VIEW-033).
//
// It lives beside the screen rather than inside it because closing is a flow with
// its own state — a question in flight and a claim just made — and because
// `TerminalScreen` has a real line ceiling that a flow this size does not belong
// under. The DECISION is pure and lives in contract/terminalClose.ts; this is the
// effectful half, and it is deliberately small enough to read in one go.
//
// It does not own tabs. The screen still owns which tabs exist and which is
// selected, and is told when one has gone — otherwise there would be two places
// deciding what is open, which is the same drift the strip's own join avoids.
import { useCallback, useState } from 'react';
import {
  decideTabClose, describeTabCloseClaim, planTabClose, SHELL_STOP_DOORS,
  type TabCloseChoiceId, type TabCloseClaim, type TabCloseDecision,
} from '../../../contract/terminalClose.js';
import type { TabSessionTruth } from '../../../contract/terminalTabStrip.js';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { TerminalAttachment } from '../../../contract/terminalServices.js';

/** The window's current hold on a session, or that it has none. */
export interface HeldAttachment {
  readonly terminalSessionId: string;
  readonly attachment: TerminalAttachment;
}

export interface TabCloseWiring {
  readonly tabs: ShellTerminalTabServices;
  /** Read at press time — a window may have failed to attach, and often has. */
  readonly held: () => HeldAttachment | null;
  readonly detach: (terminalSessionId: string, attachmentId: string) => Promise<
    { readonly succeeded: true } | { readonly succeeded: false; readonly code: string; readonly message: string }
  >;
  /** The window is gone: the screen drops the tab and picks what to show next. */
  readonly onClosed: (tabId: string) => void;
  readonly onProblem: (message: string) => void;
}

export interface TabCloseFlow {
  /** The question in flight, with the tab it is about, or `null`. */
  readonly asking: {
    readonly tabId: string;
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
  const { tabs, held, detach, onClosed, onProblem } = wiring;

  const apply = useCallback(async (
    tabId: string, choice: TabCloseChoiceId, claim: TabCloseClaim,
  ) => {
    setAsking(null);
    const holding = held();
    const plan = planTabClose(choice, holding !== null);
    if (!plan.closeRecord) return;
    if (plan.stopFirst) {
      // Unreachable through the UI — the dialog draws only choices this host can
      // keep — and it refuses loudly rather than falling through to the detach
      // path. A "Stop and close" that detached would tell Chris a process is gone
      // while it runs on (contract/terminalClose.ts).
      onProblem('NoStopDoor: this window cannot stop a terminal session.');
      return;
    }
    if (plan.detach && holding) {
      const detached = await detach(holding.terminalSessionId, holding.attachment.attachmentId);
      // Reported, and the window still closes: "I closed this window" is a Shell
      // fact a refused detach does not undo, and NOT closing here is how the
      // button became dead for exactly the sessions that most need closing.
      if (!detached.succeeded) onProblem(`${detached.code}: ${detached.message}`);
    }
    // The Shell forgets the WINDOW. It keeps the session id on the closed record,
    // and it asks the Runtime to stop nothing (FZ-VIEW-033).
    const closed = await tabs.close(tabId, mintShellOpId());
    if (!closed.ok) onProblem(`${closed.error.code}: ${closed.error.message}`);
    setClosedNote(describeTabCloseClaim(claim));
    onClosed(tabId);
  }, [tabs, held, detach, onClosed, onProblem]);

  /**
   * The press. It asks ONLY when the session is live, exactly as the row is
   * written — and remembers which tab was selected at press time, so a strip that
   * moves underneath the question cannot close the wrong window.
   */
  const requestClose = useCallback((tabId: string | null, session: TabSessionTruth) => {
    if (tabId === null) return;
    const decision = decideTabClose(session, SHELL_STOP_DOORS);
    if (decision.mustAsk) {
      setAsking({ tabId, decision });
      return;
    }
    void apply(tabId, 'keep-running', decision.claim);
  }, [apply]);

  const answer = useCallback((choice: TabCloseChoiceId) => {
    if (asking === null) return;
    if (choice === 'cancel') {
      setAsking(null);
      return;
    }
    void apply(asking.tabId, choice, asking.decision.claim);
  }, [asking, apply]);

  return {
    asking,
    closedNote,
    requestClose,
    answer,
    forgetNote: useCallback(() => setClosedNote(null), []),
  };
}

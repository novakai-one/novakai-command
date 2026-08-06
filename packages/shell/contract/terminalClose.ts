// shell/contract/terminalClose.ts — FZ-VIEW-033's close truth table, row 1.
//
//   | Close a Novakai terminal tab | Detach Shell controller
//   | must ask, if live: Keep running / Stop and close / Cancel
//   | Agent/PTY: keep running unless explicit stop |
//
// …plus the row's last clause, which is the one that decides the shape of this
// file: a crash reconciles to live / interrupted / unknown with **no false
// claim**. So the answer to "close this tab" is not one action, it is a
// DECISION with a CLAIM attached — what the Shell is entitled to say about the
// process once the window is gone.
//
// Pure: no driver, no React, no clock, no services. It is handed what the
// Runtime reported (or that it reported nothing) and hands back what to ask and
// what may be said. That is what makes the two dangerous cases — recovery and
// unknown — testable without staging a crash.
//
// THE ONE THING THIS FILE EXISTS TO PREVENT. "Stop and close" is a promise that
// a process is gone. In v4 that promise is keepable for exactly one kind of
// session: `TerminateTerminalInput` REQUIRES an `agentRunId`, and §13.4 states
// termination is "available only through Agent Runtime lifecycle authority for
// managed Agent terminals". A plain shell has no Run, so NO host can stop it
// through this contract — and the Shell's own reach into terminals
// (contract/terminalServices.ts) has no stop at all, by design (red gate 1).
// A button that says "Stop and close" and detaches would be the worst defect
// this surface can ship: Chris would read "stopped" while the process runs on.
// Unavailable is drawn as unavailable, with the reason, the same way the Runs
// screen refuses to draw an absent number as zero (FZ-VIEW-034).
import type { TabSessionTruth } from './terminalTabStrip.js';

/**
 * Which stop routes this HOST actually has. One flag rather than a service
 * object because the decision is pure — the composition root knows which doors
 * it wired, and passing the answer in keeps this file testable in both
 * directions (see the second-host case in the tests: the same code offers a real
 * Stop the moment a lifecycle door exists).
 */
export interface TerminalStopDoors {
  /**
   * Can this host ask Agent Runtime to stop a Run? B3.2 built FZ-VIEW-001's
   * `lifecycle` slice, so the answer is now yes — see `SHELL_STOP_DOORS`.
   */
  readonly agentRunLifecycle: boolean;
}

/**
 * What this Shell can reach. Declared here, next to the rule that reads it, so
 * the answer is a stated fact with one home rather than a boolean sprinkled
 * through the screens.
 *
 * It was `false` for seven seats, and that was TRUE while it was written: the
 * implemented `ShellAgentServices` had no `lifecycle` slice at all (finding
 * L-20), so a "Stop and close" would have had nothing to call. It flipped when
 * the slice was built, not when the button was wanted — which is the only order
 * that keeps the flag honest.
 *
 * Note what did NOT change: a plain shell still cannot be stopped by anyone.
 * `TerminateTerminalInput` requires an `agentRunId` and §13.4 restricts
 * termination to managed Agent terminals, so that limit is the CONTRACT's, not
 * this host's, and `terminalStopPath` still refuses it below (L-18 ruling).
 */
export const SHELL_STOP_DOORS: TerminalStopDoors = { agentRunLifecycle: true };

export type TerminalStopPath =
  | { readonly reachable: true; readonly route: 'agent-run-lifecycle' }
  | { readonly reachable: false; readonly because: string };

/**
 * Is there a route to stop the process behind this session, and if not, what
 * should a person be told?
 *
 * The reasons are written for Chris standing in front of the dialog, not for a
 * log: each one says what he can do instead, because "you cannot do that here"
 * with no next step is how a UI turns a limit into a dead end.
 */
export function terminalStopPath(
  session: TabSessionTruth,
  doors: TerminalStopDoors,
): TerminalStopPath {
  if (!session.known) {
    return {
      reachable: false,
      because: 'Novakai cannot account for this session right now, so there is nothing here to stop.',
    };
  }
  if (session.view.owner.kind === 'plain-shell') {
    return {
      reachable: false,
      because: 'This is a plain shell. Novakai can only stop a terminal it runs for an Agent, '
        + 'so end this one from inside it — type exit.',
    };
  }
  if (!doors.agentRunLifecycle) {
    return {
      reachable: false,
      because: `Stopping it means stopping ${session.view.owner.label}, which is a lifecycle `
        + 'action this window cannot make yet. Use the Run\'s own controls.',
    };
  }
  return { reachable: true, route: 'agent-run-lifecycle' };
}

/**
 * Which Run a stop from this tab would be aimed at, or `null` if there is none.
 *
 * A terminal tab knows exactly one thing about the Agent behind it: the
 * `agentRunId` on `owner.label` (`toTabView` puts it there). That single string
 * is the whole subject of a stop, and everything else the frozen `StopAgentInput`
 * wants has to be READ — see `planTerminalStop`.
 */
export function stopSubjectOf(session: TabSessionTruth): string | null {
  if (!session.known || session.view.owner.kind !== 'agent-run') return null;
  return session.view.owner.label;
}

/**
 * What the Shell may say about the process after the window is gone. Four
 * claims, and `no-claim` is the important one: it is a VALUE, so "we do not
 * know" cannot be rounded to any of the other three.
 *
 * `stopped` arrived with B3.2 and is not decoration. Before the lifecycle door
 * existed, a live session could only ever be left running, so ONE sentence
 * covered every close of a live tab. A "Stop and close" that then said "the
 * session keeps running in the background Runtime" would be the same lie as a
 * Stop button that only detaches — read off the wrong end.
 */
export type TabCloseClaim =
  | { readonly kind: 'keeps-running' }
  | { readonly kind: 'stopped'; readonly agentRunId: string }
  | { readonly kind: 'already-ended'; readonly status: string }
  | { readonly kind: 'no-claim'; readonly status: string | null };

/** The sentence. Plain, and never a claim the Runtime did not license. */
export function describeTabCloseClaim(claim: TabCloseClaim): string {
  switch (claim.kind) {
    case 'keeps-running':
      return 'Closing this window detaches it. The session keeps running in the background Runtime.';
    case 'stopped':
      return `Novakai stopped ${claim.agentRunId} and closed this window. `
        + 'The session is not running.';
    case 'already-ended':
      return `Novakai reports this session as ${claim.status}. `
        + 'Closing this window changes nothing about it.';
    case 'no-claim':
      return claim.status === null
        ? 'Novakai cannot account for this session right now. Closing this window '
          + 'claims nothing about it either way.'
        : `Novakai reports this session as ${claim.status}, which is not a running process `
          + 'and not a finished one. Closing this window claims nothing about it either way.';
  }
}

export type TabCloseChoiceId = 'keep-running' | 'stop-and-close' | 'cancel';

/**
 * `effect` is what the choice DOES, and it is deliberately independent of
 * `available`: an unavailable Stop keeps `stop-then-close`, so no caller can
 * ever quietly re-point it at the detach path. A test pins that.
 */
export interface TabCloseChoice {
  readonly id: TabCloseChoiceId;
  readonly label: string;
  readonly effect: 'detach-and-close' | 'stop-then-close' | 'nothing';
  readonly available: boolean;
  readonly unavailableBecause: string | null;
}

export type TabCloseDecision =
  | {
    readonly mustAsk: true;
    readonly claim: TabCloseClaim;
    readonly choices: readonly TabCloseChoice[];
  }
  | {
    readonly mustAsk: false;
    readonly claim: TabCloseClaim;
    readonly proceed: 'detach-and-close';
  };

/**
 * The table itself.
 *
 * ASK ONLY WHEN LIVE, exactly as the row is written. Every other status closes
 * straight away and differs only in what may be SAID afterwards — asking "keep
 * it running?" about a session that exited is a question with no true answer,
 * and asking about one that needs recovery would put the Shell in the position
 * of offering to keep running something it cannot see.
 *
 * `status` arrives as `string` (the copied-door law, rule 2), so the default
 * branch is not defensive padding: a host one version ahead of this build will
 * send a seventh member, and the honest rendering of an unrecognised state is
 * the word itself with no claim attached — never a lookup hole printing
 * "undefined", and never silently sorted in with the finished.
 */
export function decideTabClose(
  session: TabSessionTruth,
  doors: TerminalStopDoors,
): TabCloseDecision {
  if (!session.known) {
    return { mustAsk: false, claim: { kind: 'no-claim', status: null }, proceed: 'detach-and-close' };
  }
  const status: string = session.view.status;
  if (status === 'live') {
    const stop = terminalStopPath(session, doors);
    return {
      mustAsk: true,
      claim: { kind: 'keeps-running' },
      choices: [
        {
          id: 'keep-running',
          label: 'Keep running',
          effect: 'detach-and-close',
          available: true,
          unavailableBecause: null,
        },
        {
          id: 'stop-and-close',
          label: 'Stop and close',
          effect: 'stop-then-close',
          available: stop.reachable,
          unavailableBecause: stop.reachable ? null : stop.because,
        },
        {
          id: 'cancel',
          label: 'Cancel',
          effect: 'nothing',
          available: true,
          unavailableBecause: null,
        },
      ],
    };
  }
  if (status === 'exited' || status === 'failed') {
    return { mustAsk: false, claim: { kind: 'already-ended', status }, proceed: 'detach-and-close' };
  }
  return { mustAsk: false, claim: { kind: 'no-claim', status }, proceed: 'detach-and-close' };
}

/**
 * The three steps a close can involve, decided as DATA so the screen is a thin
 * executor and the sequence is testable without a PTY.
 *
 * `stopFirst` means what it says: the record closes only once the stop has
 * actually succeeded. A stop that fails must leave the tab exactly where it was
 * — closing anyway would hide a running process behind a closed window, which is
 * the same lie as a Stop button that only detaches.
 */
export interface TabClosePlan {
  readonly detach: boolean;
  readonly closeRecord: boolean;
  readonly stopFirst: boolean;
}

/**
 * `holdsAttachment` is the fix for a live defect: the old close path returned
 * early unless this window held an attachment, so a tab whose session had exited
 * (attach fails → nothing held) could not be closed at all, silently. Detaching
 * is conditional on having something to detach; closing the RECORD never was —
 * it is a Shell fact about a Shell window (FZ-VIEW-033).
 */
export function planTabClose(choice: TabCloseChoiceId, holdsAttachment: boolean): TabClosePlan {
  if (choice === 'cancel') return { detach: false, closeRecord: false, stopFirst: false };
  return {
    detach: holdsAttachment,
    closeRecord: true,
    stopFirst: choice === 'stop-and-close',
  };
}

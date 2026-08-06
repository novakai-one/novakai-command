// The effectful half of closing a window: read, stop, detach, forget — in that
// order, stopping at the first refusal (FZ-VIEW-033).
//
// It is a plain async function rather than part of the hook because the sequence
// is the dangerous thing here, not the React state around it. `useTabClose` owns
// two useStates and nothing else; this owns the order, and can therefore be
// driven directly by a test with no renderer and no DOM — which is what the
// package does everywhere else (`renderToStaticMarkup` for pictures, plain
// functions for decisions). A flow reachable only through a mounted component is
// a flow whose one dangerous failure mode is tested through markup.
import {
  describeTabCloseClaim, planTabClose,
  type TabCloseChoiceId, type TabCloseClaim,
} from '../../../contract/terminalClose.js';
import { describeStopRefusal, planTerminalStop } from '../../../contract/agentLifecycle.js';
import type { ShellAgentServices } from '../../../contract/agentRuns.js';
import { mintShellOpId, type ShellTerminalTabServices } from '../../../contract/services.js';
import type { TerminalAttachment } from '../../../contract/terminalServices.js';

/** The window's current hold on a session, or that it has none. */
export interface HeldAttachment {
  readonly terminalSessionId: string;
  readonly attachment: TerminalAttachment;
}

export interface TabCloseWiring {
  readonly tabs: ShellTerminalTabServices;
  /**
   * FZ-VIEW-001's `runs` and `lifecycle` slices — the real ones, not a pair of
   * functions assembled here. A stop needs BOTH: `runs.getAgentRun` is the only
   * honest source of the `agentId` the frozen `StopAgentInput` wants, and
   * `lifecycle.stopAgent` is the only thing that can stop anything.
   */
  readonly agentRuns: Pick<ShellAgentServices, 'runs' | 'lifecycle'>;
  /** Read at press time — a window may have failed to attach, and often has. */
  readonly held: () => HeldAttachment | null;
  readonly detach: (terminalSessionId: string, attachmentId: string) => Promise<
    { readonly succeeded: true } | { readonly succeeded: false; readonly code: string; readonly message: string }
  >;
  /** The window is gone: the screen drops the tab and picks what to show next. */
  readonly onClosed: (tabId: string) => void;
  readonly onProblem: (message: string) => void;
}

/** What the press was about, decided at press time and carried here whole. */
export interface TabCloseRequest {
  readonly tabId: string;
  readonly choice: TabCloseChoiceId;
  readonly claim: TabCloseClaim;
  /** The Run a stop would be aimed at, or `null` when there is none. */
  readonly subject: string | null;
}

/**
 * Read, then aim, then send — and stop at the first refusal.
 *
 * `true` means the process is gone and the window may close. Every `false` path
 * LEAVES THE TAB WHERE IT WAS: a stop that did not happen behind a window that
 * closed anyway is a running process hidden by a closed window, which is the
 * same lie the whole close contract exists to prevent. Nothing here retries, and
 * nothing invents an `agentId` from the Run id.
 */
async function stopSubject(
  wiring: TabCloseWiring, agentRunId: string | null,
): Promise<boolean> {
  if (agentRunId === null) {
    wiring.onProblem(describeStopRefusal('This terminal does not belong to an Agent Run.'));
    return false;
  }
  const plan = planTerminalStop(agentRunId, await wiring.agentRuns.runs.getAgentRun({ agentRunId }));
  if (!plan.send) {
    wiring.onProblem(describeStopRefusal(plan.because));
    return false;
  }
  const stopped = await wiring.agentRuns.lifecycle.stopAgent(plan.request);
  if (!stopped.ok) {
    wiring.onProblem(describeStopRefusal(`${stopped.error.code}: ${stopped.error.message}`));
    return false;
  }
  return true;
}

/**
 * Run one close to its end. Answers with the sentence the screen is entitled to
 * draw, or `null` when the window did NOT close — which is a value, so a caller
 * cannot accidentally announce a close that did not happen.
 */
export async function runTabClose(
  wiring: TabCloseWiring, request: TabCloseRequest,
): Promise<string | null> {
  const holding = wiring.held();
  const plan = planTabClose(request.choice, holding !== null);
  if (!plan.closeRecord) return null;
  let said = request.claim;
  if (plan.stopFirst) {
    if (!await stopSubject(wiring, request.subject)) return null;
    // The claim is REPLACED, not kept. `keeps-running` was true of the tab a
    // moment ago and is false of it now, and the sentence under a closed window
    // is the only record of what the press accomplished.
    said = { kind: 'stopped', agentRunId: request.subject! };
  }
  if (plan.detach && holding) {
    const detached = await wiring.detach(holding.terminalSessionId, holding.attachment.attachmentId);
    // Reported, and the window still closes: "I closed this window" is a Shell
    // fact a refused detach does not undo, and NOT closing here is how the
    // button became dead for exactly the sessions that most need closing.
    if (!detached.succeeded) wiring.onProblem(`${detached.code}: ${detached.message}`);
  }
  // The Shell forgets the WINDOW. It keeps the session id on the closed record,
  // and it asks the Runtime to stop nothing (FZ-VIEW-033).
  const closed = await wiring.tabs.close(request.tabId, mintShellOpId());
  if (!closed.ok) wiring.onProblem(`${closed.error.code}: ${closed.error.message}`);
  wiring.onClosed(request.tabId);
  return describeTabCloseClaim(said);
}

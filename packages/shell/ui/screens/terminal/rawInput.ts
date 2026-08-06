// shell/ui/screens/terminal/rawInput.ts — the Raw half of FZ-VIEW-032.
//
//   Raw mode passes provider-native slash commands through unchanged **under
//   the input lease**.
//
// Both halves of that clause were broken here. The passthrough was fine, but it
// happened without ever asking the one function that owns the question — so
// "Raw is unchanged" was an accident of this file rather than a rule. And the
// lease clause was a bare `return`: with no attachment, or with a lease this
// window does not hold, every keystroke was DROPPED IN SILENCE. Chris types,
// the terminal shows nothing, and there is no way to tell that from a hung
// process. Whatever else a terminal does, it must never eat input quietly.
//
// Pure: no xterm, no services, no clock. It decides; the screen executes.
import { readSlashInput, SHELL_SLASH_DOORS, type SlashSituation } from '../../../contract/index.js';
import type {
  TerminalAttachment, TerminalServices, TerminalTabView,
} from '../../../contract/terminalServices.js';

export interface RawInputDecision {
  /** Exactly what to put on the wire, byte-for-byte, or null if nothing goes. */
  readonly send: string | null;
  /** A line to draw in the terminal, or null if there is nothing new to say. */
  readonly announce: string | null;
}

/**
 * `alreadyAnnounced` is why this is a function and not an `if`. `onData` fires
 * per keystroke, so a refusal drawn every time would bury the screen in its own
 * apology — the sentence is worth saying once per blocked run, and again only
 * after input starts working and stops again.
 */
export function decideRawInput(
  data: string,
  context: {
    readonly attachment: TerminalAttachment | null;
    readonly sessionId: string | null;
    readonly alreadyAnnounced: boolean;
  },
): RawInputDecision {
  const held = context.attachment;
  const situation: SlashSituation = {
    surface: 'raw',
    // The three ways this window has no write: nothing attached, no session, or
    // an attachment carrying no lease (§13.4 — many may read, one may write).
    holdsInputLease: held !== null && held.leaseId !== '' && context.sessionId !== null,
    providerDeclared: [],
    doors: SHELL_SLASH_DOORS,
  };
  const answer = readSlashInput(data, situation);
  if (answer.kind === 'raw-passthrough') return { send: answer.text, announce: null };
  if (answer.kind === 'raw-blocked') {
    if (context.alreadyAnnounced) return { send: null, announce: null };
    // The rule states the fact; this states the CAUSE, and only the one it can
    // see. An attachment with no lease means somebody else is writing. No
    // attachment means nothing here is connected — which is also what an exited
    // session looks like, so it must not be reported as a rival controller.
    const cause = held !== null && held.leaseId === ''
      ? ' Another window is typing into it — take input over here first.'
      : ' Nothing is attached here.';
    return { send: null, announce: answer.because + cause };
  }
  // Unreachable by construction: `surface: 'raw'` has exactly two answers. Left
  // as a refusal rather than a fallthrough to the wire — a Raw surface that
  // started routing Calm answers would be the second parser this row forbids.
  return { send: null, announce: null };
}

/** The refusal as it appears in the buffer — its own line, never mixed into
 * program output, and bracketed the way every other Shell aside on this screen
 * is (`[the terminal exited]`, `[earlier output is no longer buffered]`). */
export const rawInputNotice = (because: string): string => `\r\n[${because}]\r\n`;

/** The refs the handler reads at keystroke time. Refs rather than state because
 * `onData` is registered ONCE and outlives every tab switch — a closed-over
 * value would be typing into the tab you left. */
export interface RawInputRefs {
  readonly attachment: { current: TerminalAttachment | null };
  readonly attachedTo: { current: string | null };
  readonly inputSequence: { current: number };
  readonly blockedAnnounced: { current: boolean };
}

/**
 * The whole journey of one keystroke: decide, say what did not happen, then put
 * the bytes on the wire and keep the sequence honest afterwards.
 */
export function makeRawInputHandler(deps: {
  readonly services: TerminalServices;
  readonly write: (text: string) => void;
  readonly refresh: () => Promise<readonly TerminalTabView[]>;
  readonly onProblem: (message: string) => void;
  readonly refs: RawInputRefs;
}): (data: string) => void {
  const { attachment, attachedTo, inputSequence, blockedAnnounced } = deps.refs;
  return (data: string) => {
    const held = attachment.current;
    const sessionId = attachedTo.current;
    const decision = decideRawInput(data, {
      attachment: held, sessionId, alreadyAnnounced: blockedAnnounced.current,
    });
    if (decision.announce !== null) {
      blockedAnnounced.current = true;
      deps.write(rawInputNotice(decision.announce));
    }
    if (decision.send === null || held === null || sessionId === null) return;
    blockedAnnounced.current = false;
    const sequence = inputSequence.current;
    inputSequence.current += 1;
    void deps.services.write(sessionId, held, decision.send, sequence).then(async (written) => {
      if (written.succeeded) return;
      deps.onProblem(`${written.code}: ${written.message}`);
      // A refused write leaves this window's idea of the stream wrong, and
      // repeating the same wrong number refuses forever. Ask again.
      const truth = await deps.refresh();
      inputSequence.current = truth.find((item) => item.terminalSessionId === sessionId)
        ?.nextInputSequence ?? sequence;
    });
  };
}

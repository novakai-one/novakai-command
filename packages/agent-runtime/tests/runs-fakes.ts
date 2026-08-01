// The Terminal and provider fakes.
//
// Split from `runs-harness.ts` so that file is the RIG and this one is what the
// rig pretends to be talking to.
import {
  b3err, b3fail, b3ok, mintTerminalSessionId,
  type ProviderSessionId, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  ProviderPort, TerminalFacts, TerminalPort,
} from '../contract/ports.js';
import type { TurnDeliveryStep } from '../contract/types.js';

// ── A fake Terminal that remembers exactly what was typed into it ───────────

/**
 * How the scripted agent behaves when the gate speaks to it. The whole gate
 * matrix is one knob, because every case is the same experiment with a
 * different reply.
 */
export type ScriptedReply =
  | 'valid' | 'silent' | 'malformed' | 'missing-token' | 'extra-token'
  | 'duplicate-token' | 'out-of-order' | 'empty';

export interface FakeTerminal extends TerminalPort {
  readonly opened: { id: TerminalSessionId; fingerprint: string; authority: string }[];
  readonly submitted: {
    terminalSessionId: TerminalSessionId;
    keystrokes: readonly TurnDeliveryStep[];
    /** What those keystrokes spell, for the tests that are about the words. */
    text: string;
    effectKey: string;
  }[];
  readonly terminated: TerminalSessionId[];
  /** What `readOutputSoFar` returns — a test may also write this directly. */
  output: string;
  /** What the scripted agent replies to the gate's turn 1. */
  reply: ScriptedReply;
  /**
   * The tokens the scripted agent will name — set by the rig from the SAME
   * pinned skills the role was defined with, so the reply is independent
   * evidence rather than the prompt read back.
   */
  pinnedTokens: readonly string[];
  failOpen: ReturnType<typeof b3err> | null;
  interruptOutcome: 'barrier-committed' | 'target-turn-not-active' | 'raced-with-completion';
  failTerminate: ReturnType<typeof b3err> | null;
  /**
   * Run something INSIDE a terminate, once. It is the only way to land a
   * command in the middle of a stop-tree from outside: the fence exists only
   * while the stop is executing, and a test that waits for the stop to finish
   * has already missed the window it is trying to prove.
   */
  duringNextTerminate: (() => Promise<void>) | null;
  /**
   * Echo like a REAL TUI: re-wrap what was typed at this width instead of
   * echoing it back line for line.
   *
   * Every gate test until now ran against a session that echoed exactly what it
   * was handed, so "strip the lines we typed" worked perfectly — and in the
   * field the claude composer takes one long line, re-wraps it at the window
   * width, and paints each word at an explicit cursor column, which leaves the
   * Runtime's own words on screen in a shape no line-set subtraction can find.
   * The re-probe measured 9 of 13 governed spawns and 3 of 3 continuations dying
   * on it (NVK-KIMI-030 N-1). `null` keeps the old faithful echo.
   */
  reflowColumns: number | null;
}

/**
 * What the screen looks like after a TUI has painted a turn.
 *
 * Two things happen and both matter. The text is re-wrapped, so no row is a
 * line the Runtime composed; and the spaces vanish, because the provider moves
 * the cursor between words with CSI sequences rather than emitting them, and
 * `plainText` strips those. The re-probe read exactly this off a real Run:
 * `SKILLS-CONFIRMED:thenonespace,thenaJSONarrayofthetokensabove,quoted,...`
 */
export function reflow(text: string, columns: number): string {
  const painted = text.split(/\s+/u).filter((word) => word !== '').join('');
  const rows: string[] = [];
  for (let start = 0; start < painted.length; start += columns) {
    rows.push(painted.slice(start, start + columns));
  }
  return rows.join('\n');
}

const MARKER = 'SKILLS-CONFIRMED:';

/**
 * What the scripted agent believes its pinned skills are.
 *
 * It is TOLD, never derived from the prompt. A fake that read the answer out of
 * the question could not tell a working gate from one that accepts its own
 * words back, which is exactly the defect this fake used to hide
 * (NVK-KIMI-028 finding 4): every gate test passed while a silent, echoing
 * session confirmed itself in production.
 */
function scriptedConfirmation(
  tokens: readonly string[], reply: ScriptedReply,
): string | null {
  if (reply === 'silent') return null;
  if (reply === 'malformed') return `${MARKER} not json at all`;
  if (reply === 'empty') return `${MARKER} []`;
  if (reply === 'missing-token') return `${MARKER} ${JSON.stringify(tokens.slice(1))}`;
  if (reply === 'extra-token') {
    return `${MARKER} ${JSON.stringify([...tokens, 'smuggled@v1#digest'].sort())}`;
  }
  if (reply === 'duplicate-token') {
    return `${MARKER} ${JSON.stringify([...tokens, tokens[0] ?? 'x'])}`;
  }
  if (reply === 'out-of-order') return `${MARKER} ${JSON.stringify([...tokens].reverse())}`;
  return `${MARKER} ${JSON.stringify([...tokens])}`;
}

export function createFakeTerminal(): FakeTerminal {
  const sessions = new Map<TerminalSessionId, TerminalFacts>();
  /** One PTY per open OPERATION, so a retry adopts instead of launching. */
  const byOperation = new Map<string, TerminalFacts>();
  const port: FakeTerminal = {
    opened: [],
    submitted: [],
    terminated: [],
    output: '',
    reply: 'valid',
    pinnedTokens: [],
    failOpen: null,
    interruptOutcome: 'barrier-committed',
    failTerminate: null,
    duringNextTerminate: null,
    reflowColumns: null,

    async openManagedTerminal(context, input) {
      if (port.failOpen) {
        const error = port.failOpen;
        port.failOpen = null;
        return b3fail(error);
      }
      // The REAL Terminal keys an open on `{principal, operation, clientOpId}`
      // and, on a retry, adopts the PTY its own earlier attempt started rather
      // than launching a second one (§13.5, packages/terminal/core/sessions.ts).
      // A fake that opened a fresh PTY per call would let a duplicate-launch
      // bug pass, so it keys the same way.
      const adoptionKey = `${context.clientOpId}:${input.launchFingerprint}`;
      const adopted = byOperation.get(adoptionKey);
      if (adopted !== undefined) return b3ok(adopted);

      const id = mintTerminalSessionId();
      const opened: TerminalFacts = { id, status: 'live' };
      sessions.set(id, opened);
      byOperation.set(adoptionKey, opened);
      port.opened.push({
        id, fingerprint: input.launchFingerprint, authority: input.launchAuthorityRef,
      });
      return b3ok(opened);
    },

    async submitRuntimeInput(_context, input) {
      const typed = input.keystrokes.map((step) => step.utf8Text).join('');
      port.submitted.push({ ...input, text: typed });
      // A real PTY shows what was typed at it, and §13.5's "retry observes
      // transcript before sending again" reads exactly that. A fake whose
      // output never contained the prompt would let a re-prompting retry pass.
      port.output = `${port.output}${
        port.reflowColumns === null ? typed : reflow(typed, port.reflowColumns)}\n`;
      // And a real composer only ANSWERS a turn that was actually submitted.
      // A fake that replies to bytes alone cannot tell a sent turn from one
      // sitting in a composer for ever, which is the whole of hold-out B3.
      if (!typed.includes('\r')) return b3ok({ confirmed: false });
      // A scripted agent answers turn 1 — correctly, or with one of the ways an
      // agent gets it wrong. Turn 1 is the one that HOLDS the work; turn 2
      // releases it and is never answered.
      if (input.effectKey.endsWith('skills-gate-prompt-sent')) {
        const answer = scriptedConfirmation(port.pinnedTokens, port.reply);
        if (answer !== null) port.output = `${port.output}\nthinking...\n${answer}\n`;
      }
      return b3ok({ confirmed: true });
    },

    async readOutputSoFar() { return b3ok(port.output); },
    async beginProviderTurn() { return b3ok(null); },
    async endProviderTurn() { return b3ok(null); },

    async interruptTurn(input) {
      if (port.interruptOutcome === 'target-turn-not-active') {
        return b3ok({ kind: 'target-turn-not-active' });
      }
      return b3ok({ kind: port.interruptOutcome, providerTurnId: input.providerTurnId });
    },

    async terminate(input) {
      const during = port.duringNextTerminate;
      if (during !== null) {
        port.duringNextTerminate = null;
        await during();
      }
      if (port.failTerminate) {
        const error = port.failTerminate;
        port.failTerminate = null;
        return b3fail(error);
      }
      port.terminated.push(input.terminalSessionId);
      sessions.set(input.terminalSessionId, {
        id: input.terminalSessionId, status: 'exited',
      });
      return b3ok(null);
    },

    async getTerminal(_principal, terminalSessionId) {
      return b3ok(sessions.get(terminalSessionId) ?? null);
    },
  };
  return port;
}

// ── A fake provider ─────────────────────────────────────────────────────────

export interface FakeProviders extends ProviderPort {
  readonly launched: { authorityRef: string; fingerprint: string }[];
  /** Return a DIFFERENT session id, to prove substitution is refused. */
  substituteSessionId: ProviderSessionId | null;
  discoveryFails: ReturnType<typeof b3err> | null;
  nativeSessionId: string;
}

export function createFakeProviders(): FakeProviders {
  const port: FakeProviders = {
    launched: [],
    substituteSessionId: null,
    discoveryFails: null,
    nativeSessionId: 'native-session',

    async prepareLaunch(input) {
      const authorityRef = `authority:${input.agentRunId}`;
      const fingerprint = `${input.launchPlan.provider}:${input.launchPlan.workingDirectory}`;
      port.launched.push({ authorityRef, fingerprint });
      return b3ok({ launchAuthorityRef: authorityRef, launchFingerprint: fingerprint });
    },

    async prepareContinuation(input) {
      const authorityRef = `authority:${input.mode}:${input.agentRunId}`;
      port.launched.push({ authorityRef, fingerprint: `${input.mode}` });
      return b3ok({
        launchAuthorityRef: authorityRef,
        launchFingerprint: `${input.mode}`,
        providerNativeSessionId: input.mode === 'resume' || input.mode === 'compact'
          ? input.oldNativeSessionId : port.nativeSessionId,
        resumeHandleUsed: input.mode === 'resume' || input.mode === 'compact',
      });
    },

    async discoverSession(input) {
      if (port.discoveryFails) {
        const error = port.discoveryFails;
        port.discoveryFails = null;
        return b3fail(error);
      }
      return b3ok({
        providerSessionId: port.substituteSessionId ?? input.expectedProviderSessionId,
        providerNativeSessionId: port.nativeSessionId,
        live: 'live',
      });
    },

    async requestInterrupt() { return b3ok({ kind: 'interrupt-requested' }); },
    deliverTurn: (_provider, text) => [
      { utf8Text: text, pauseMsAfter: 0 },
      { utf8Text: '\r', pauseMsAfter: 0 },
    ],
    findConfirmationLine: (_provider, text, marker) => {
      const lines = text.split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]!.trim();
        if (line.startsWith(marker)) return line;
      }
      return null;
    },
  };
  return port;
}


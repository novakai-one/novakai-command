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
  readonly submitted: { terminalSessionId: TerminalSessionId; text: string; effectKey: string }[];
  readonly terminated: TerminalSessionId[];
  /** What `readOutputSoFar` returns — a test may also write this directly. */
  output: string;
  /** What the scripted agent replies to the gate's turn 1. */
  reply: ScriptedReply;
  failOpen: ReturnType<typeof b3err> | null;
  interruptOutcome: 'barrier-committed' | 'target-turn-not-active' | 'raced-with-completion';
  failTerminate: ReturnType<typeof b3err> | null;
}

const MARKER = 'SKILLS-CONFIRMED:';

/** The tokens the gate PINNED, read back out of the prompt it just sent. */
function pinnedTokens(prompt: string): string[] {
  const line = prompt.split(/\r?\n/).find((item) => item.trim().startsWith(MARKER));
  if (line === undefined) return [];
  try {
    return JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length).trim()) as string[];
  } catch {
    return [];
  }
}

function scriptedConfirmation(prompt: string, reply: ScriptedReply): string | null {
  const tokens = pinnedTokens(prompt);
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
  return `${MARKER} ${JSON.stringify(tokens)}`;
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
    failOpen: null,
    interruptOutcome: 'barrier-committed',
    failTerminate: null,

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
      port.submitted.push(input);
      // A scripted agent answers turn 1 — with what the prompt asked for, or
      // with one of the ways an agent gets it wrong.
      if (input.text.includes(MARKER)) {
        const answer = scriptedConfirmation(input.text, port.reply);
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
    submitTurn: (_provider, text) => `${text}\n`,
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


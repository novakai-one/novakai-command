// The Terminal and provider fakes.
//
// Split from `runs-harness.ts` so that file is the RIG and this one is what the
// rig pretends to be talking to.
import {
  b3err, b3fail, b3ok, mintTerminalInputAttemptId, mintTerminalSessionId,
  notificationInputReservationId, nowIsoUtc,
  type NotificationInputReservationId, type ProviderSessionId,
  type ProviderTurnBoundaryProfileId, type RecordVersion, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  NotificationInputAttemptFacts, NotificationInputReservationFacts,
  ProviderPort, ProviderTurnInputAttemptFacts, TerminalFacts, TerminalPort,
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
  /** Pause one Q7 reservation so a contract test can race another public Run command. */
  duringNextNotificationReservation: (() => Promise<void>) | null;
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
  /**
   * Paint the ANSWER the way a real TUI repaints a row it has already drawn:
   * jump the cursor over the columns that are already correct, and emit only
   * the runs that changed.
   *
   * `reflowColumns` above simulates the screen a reader sees AFTER the escape
   * sequences have been taken out — it emits no escapes at all — so the step
   * that reads them was never under test, and NVK-048 class 6 lived there for
   * the whole of B3: a verbatim-correct confirmation rejected ~1 spawn in 3
   * because the read deleted a character the provider had no need to send
   * twice (`nvk048-skll@v1#d0`, from `p10`'s own failure record).
   */
  repaintAnswer: boolean;
}

/**
 * One row, drawn and then redrawn — the second pass stepping over a column that
 * is already correct.
 *
 * The grammar is copied off a real claude PTY capture, where the Runtime's own
 * sentence came back as `then a\x1b[26GJSON\x1b[32Grray of the\x1b[44Gt\x1b[46Gkens`
 * for a screen reading `then a JSON array of the tokens`
 * (`packages/agents/b3/tests/fixtures/claude-gate-screen.txt`). The character
 * stepped over is inside the token, which is what makes it fatal rather than
 * cosmetic.
 */
export function repaint(said: string, steppedOver: number): string {
  const column = 2;
  const column0 = (zeroBased: number): string => `[${String(zeroBased + 1)}G`;
  return [
    '\r\n', column0(column), said.slice(0, steppedOver + 1),
    '\r', column0(column), said.slice(0, steppedOver),
    column0(column + steppedOver + 1), said.slice(steppedOver + 1),
    '[K\r\n',
  ].join('');
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
  const notificationReservations = new Map<
    NotificationInputReservationId, NotificationInputReservationFacts
  >();
  const notificationAttempts = new Map<string, NotificationInputAttemptFacts>();
  const providerTurnAttempts = new Map<string, ProviderTurnInputAttemptFacts>();
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
    duringNextNotificationReservation: null,
    reflowColumns: null,
    repaintAnswer: false,

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
      const attempted = {
        terminalInputAttemptId: mintTerminalInputAttemptId(),
        submittedAt: nowIsoUtc(),
      };
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
      if (!typed.includes('\r')) return b3ok({ confirmed: false, ...attempted });
      // A scripted agent answers turn 1 — correctly, or with one of the ways an
      // agent gets it wrong. Turn 1 is the one that HOLDS the work; turn 2
      // releases it and is never answered.
      if (input.effectKey.endsWith('skills-gate-prompt-sent')) {
        const answer = scriptedConfirmation(port.pinnedTokens, port.reply);
        if (answer !== null) {
          port.output = `${port.output}\nthinking...\n${
            port.repaintAnswer
              // Stepped over mid-token — inside the digest, where the
              // fixture's own drops landed — rather than on a space.
              ? repaint(answer, answer.indexOf('#') + 1)
              : `${answer}\n`}`;
        }
      }
      return b3ok({ confirmed: true, ...attempted });
    },

    async reserveNotificationInput(input) {
      const during = port.duringNextNotificationReservation;
      if (during !== null) {
        port.duringNextNotificationReservation = null;
        await during();
      }
      const id = notificationInputReservationId(input.effectKey);
      const prior = notificationReservations.get(id);
      if (prior !== undefined) return b3ok(prior);
      const reservation: NotificationInputReservationFacts = {
        id,
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
        notificationId: input.notificationId,
        deliveryEffectKey: input.effectKey,
        expectedActivityGeneration: input.expectedActivityGeneration,
        providerTurnId: input.providerTurnId,
        state: 'reserved',
      };
      notificationReservations.set(id, reservation);
      return b3ok(reservation);
    },

    async commitReservedNotificationInput(input) {
      const prior = notificationReservations.get(input.notificationInputReservationId);
      if (prior === undefined) {
        return b3fail(b3err(
          'ValidationFailed', 'unknown fake Notification reservation', {}, false,
        ));
      }
      if (prior.state === 'cancelled') {
        return b3fail(b3err(
          'IdempotencyConflict', 'fake Notification reservation was cancelled', {}, false,
        ));
      }
      if (prior.state === 'committed' && prior.terminalInputAttemptId !== undefined) {
        const attempt = notificationAttempts.get(prior.terminalInputAttemptId);
        if (attempt !== undefined) return b3ok({ reservation: prior, attempt });
      }
      const submittedAt = nowIsoUtc();
      const attempt: NotificationInputAttemptFacts = {
        id: mintTerminalInputAttemptId(),
        notificationInputReservationId: prior.id,
        deliveryEffectKey: prior.deliveryEffectKey,
        providerTurnId: prior.providerTurnId,
        outcome: 'submitted-confirmed',
        submittedAt,
      };
      const reservation: NotificationInputReservationFacts = {
        ...prior,
        state: 'committed',
        terminalInputAttemptId: attempt.id,
        endedAt: submittedAt,
      };
      notificationAttempts.set(attempt.id, attempt);
      notificationReservations.set(reservation.id, reservation);
      port.output = `${port.output}${input.utf8Text}`;
      return b3ok({ reservation, attempt });
    },

    async cancelReservedNotificationInput(input) {
      const prior = notificationReservations.get(input.notificationInputReservationId);
      if (prior === undefined) {
        return b3fail(b3err(
          'ValidationFailed', 'unknown fake Notification reservation', {}, false,
        ));
      }
      const cancelled: NotificationInputReservationFacts = {
        ...prior,
        state: 'cancelled',
        endedAt: nowIsoUtc(),
      };
      notificationReservations.set(cancelled.id, cancelled);
      return b3ok(cancelled);
    },

    async getNotificationInputReservation(notificationInputReservationId) {
      return b3ok(notificationReservations.get(notificationInputReservationId) ?? null);
    },

    async getNotificationInputAttempt(terminalInputAttemptId) {
      return b3ok(notificationAttempts.get(terminalInputAttemptId) ?? null);
    },

    async prepareProviderTurnInput(input) {
      const prior = [...providerTurnAttempts.values()].find((attempt) =>
        attempt.providerTurnSubmissionId === input.providerTurnSubmissionId
        && attempt.deliveryAttemptOrdinal === input.deliveryAttemptOrdinal);
      if (prior !== undefined) return b3ok({ kind: 'prepared' as const, attempt: prior });
      const attempt: ProviderTurnInputAttemptFacts = {
        id: mintTerminalInputAttemptId(),
        recordVersion: 1 as RecordVersion,
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
        providerTurnSubmissionId: input.providerTurnSubmissionId,
        deliveryAttemptOrdinal: input.deliveryAttemptOrdinal,
        providerTurnId: input.providerTurnId,
        activityGeneration: input.activityGeneration,
        submissionEffectKey: input.submissionEffectKey,
        providerSessionId: input.providerSessionId,
        transcriptBindingId: input.transcriptBindingId,
        inputSequence: 1,
        payloadDigest: input.inputDigest,
        authority: input.authority.kind === 'controller'
          ? { kind: 'controller', resumeDeadlineAt: nowIsoUtc() }
          : { kind: 'runtime-safe-boundary' },
        effectState: { kind: 'prepared', preparedAt: nowIsoUtc() },
        turnBarrier: { kind: 'reserved-pre-effect' },
      };
      providerTurnAttempts.set(attempt.id, attempt);
      return b3ok({ kind: 'prepared' as const, attempt });
    },

    async executeProviderTurnInput(input) {
      const attempt = providerTurnAttempts.get(input.terminalInputAttemptId);
      if (attempt === undefined) {
        return b3fail(b3err('ProviderTurnSubmissionConflict', 'unknown fake attempt', {}, false));
      }
      if (attempt.effectState.kind === 'submitted-confirmed'
        || attempt.effectState.kind === 'submitted-unconfirmed') return b3ok(attempt);
      const submitted: ProviderTurnInputAttemptFacts = {
        ...attempt,
        recordVersion: (attempt.recordVersion + 1) as RecordVersion,
        effectState: { kind: 'submitted-confirmed', submittedAt: nowIsoUtc() },
        turnBarrier: { kind: 'active', activatedAt: nowIsoUtc() },
      };
      providerTurnAttempts.set(submitted.id, submitted);
      port.submitted.push({
        terminalSessionId: submitted.terminalSessionId,
        keystrokes: [
          { utf8Text: input.utf8Text, pauseMsAfter: 0 },
          { utf8Text: '\r', pauseMsAfter: 0 },
        ],
        text: `${input.utf8Text}\r`,
        effectKey: input.submissionEffectKey,
      });
      port.output = `${port.output}${input.utf8Text}\r\n`;
      if (input.utf8Text.includes('do NOT begin it yet')) {
        const answer = scriptedConfirmation(port.pinnedTokens, port.reply);
        if (answer !== null) port.output = `${port.output}${answer}\n`;
      }
      return b3ok(submitted);
    },

    async cancelPreparedProviderTurnInput(input) {
      const attempt = providerTurnAttempts.get(input.terminalInputAttemptId);
      if (attempt === undefined) {
        return b3fail(b3err('ProviderTurnSubmissionConflict', 'unknown fake attempt', {}, false));
      }
      const rejected: ProviderTurnInputAttemptFacts = {
        ...attempt,
        recordVersion: (attempt.recordVersion + 1) as RecordVersion,
        effectState: {
          kind: 'rejected', rejectedAt: nowIsoUtc(), effectEscaped: false,
          reason: input.reason,
        },
        turnBarrier: { kind: 'released-rejected', releasedAt: nowIsoUtc() },
      };
      providerTurnAttempts.set(rejected.id, rejected);
      return b3ok(rejected);
    },

    async getProviderTurnInputAttempt(input) {
      return b3ok([...providerTurnAttempts.values()].find((attempt) =>
        attempt.terminalSessionId === input.terminalSessionId
        && attempt.providerTurnId === input.providerTurnId
        && attempt.submissionEffectKey === input.submissionEffectKey) ?? null);
    },

    async listIncompleteProviderTurnInputAttempts(input) {
      return b3ok([...providerTurnAttempts.values()].filter((attempt) =>
        (input.terminalSessionId === undefined
          || attempt.terminalSessionId === input.terminalSessionId)
        && (input.agentRunId === undefined || attempt.agentRunId === input.agentRunId)
        && attempt.turnBarrier.kind !== 'completion-committed'
        && attempt.turnBarrier.kind !== 'closed-unproven'
        && attempt.turnBarrier.kind !== 'released-rejected'));
    },

    async settleProviderTurnCompletion(input) {
      const attempt = providerTurnAttempts.get(input.terminalInputAttemptId);
      if (attempt === undefined || attempt.providerTurnId !== input.providerTurnId) {
        return b3ok({ kind: 'target-turn-not-active' as const, inputLeaseChanged: false as const });
      }
      const settled: ProviderTurnInputAttemptFacts = {
        ...attempt,
        recordVersion: (attempt.recordVersion + 1) as RecordVersion,
        turnBarrier: {
          kind: 'completion-committed',
          transcriptTurnCompletionId: input.transcriptTurnCompletionId,
          providerUsageEvidenceId: input.providerUsageEvidenceId,
          interruptDisposition: 'no-barrier',
        },
      };
      providerTurnAttempts.set(settled.id, settled);
      return b3ok({
        kind: 'completion-barrier-committed' as const,
        attemptRecordVersion: settled.recordVersion,
        interruptDisposition: 'no-barrier' as const,
      });
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

    async turnBoundaryCapability() {
      return b3ok({
        testedProviderVersion: 'fake-1.0.0',
        profileId: 'turnBoundaryProfile_fake' as ProviderTurnBoundaryProfileId,
      });
    },

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
        providerVersion: 'fake-1.0.0',
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

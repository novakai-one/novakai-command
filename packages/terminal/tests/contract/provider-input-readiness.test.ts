// A first turn is never written into a provider that is not reading yet
// (NVK-KIMI-078 diagnosis, NVK-KIMI-079 fix).
//
// The scripted PTY here emits the real thing: the 77-byte terminal-capability
// burst claude 2.1.219 opens with, byte for byte from
// `build-reports/nvk078/probe-ready1.screen.txt`. That burst is what the
// product used to write into. Novakai answers none of those queries, so the CLI
// stays in its response parser and eats whatever arrives — the turn never
// becomes a provider turn, no transcript is written at all, and the skills gate
// spends 120 s blaming an agent that was never asked anything.
//
// The predicate injected below is claude's shape (two full-width `─` rules =
// the composer box's borders). It is stated here rather than imported because
// Terminal does not depend on Agents — the AUTHORITY for the predicate itself
// is `agents/b3/tests/provider-input-readiness.test.ts`, which runs the real
// adapter against real boot captures of all three CLIs. This suite is about the
// GATE: refuse, write nothing, and stay retryable.
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deterministicId,
  mintProviderSessionId,
  mintProviderTurnId,
  providerTurnSubmissionId,
  type ActivityGeneration,
  type ProviderSessionId,
  type RecordVersion,
  type TranscriptBindingId,
} from '@novakai/foundation/contract';
import {
  createRig, expectError, humanPrincipal, openMockManagedSession, runtimeContext,
  someAgentRunId, unwrap,
  type Rig,
} from '../harness.js';

const GENERATION = 11 as ActivityGeneration;
const RUN_VERSION = 4 as RecordVersion;
const TEXT = 'You are a governed Novakai agent. Confirm your skills.';
const EFFECT_KEY = 'b3d:nvk079:readiness:1';
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);

/**
 * Claude 2.1.219's opening burst, verbatim: bracketed paste, Kitty keyboard
 * protocol, background-colour query, two Primary Device Attributes, XTVERSION.
 * Nothing here is a composer, and a terminal that answers none of it leaves the
 * CLI parked in its parser.
 */
const CAPABILITY_BURST = [
  `${ESC}7`, `${ESC}[r`, `${ESC}8`, `${ESC}[?25h`, `${ESC}[?25l`,
  `${ESC}[?2004h`, `${ESC}[?1004h`, `${ESC}[?2031h`,
  `${ESC}[<u`, `${ESC}[>1u`, `${ESC}[>4;2m`,
  `${ESC}]11;?${BELL}`, `${ESC}[c`, `${ESC}[>0q`, `${ESC}[c`,
].join('');

/** The composer box: two full-width rules with the `❯` placeholder between. */
const COMPOSER = `${'─'.repeat(120)}\r\n❯ Try "fix typecheck errors"\r\n${'─'.repeat(120)}\r\n`;

const claudeInputReady = async (_session: ProviderSessionId, screen: string): Promise<boolean> =>
  (screen.match(/─{8,}/gu) ?? []).length >= 2;

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

async function prepareTurn(rig: Rig, terminalSessionId: string) {
  const providerTurnId = mintProviderTurnId();
  const prepared = unwrap(await rig.terminal.prepareProviderTurnInput(runtimeContext(), {
    terminalSessionId: terminalSessionId as never,
    agentRunId: someAgentRunId,
    providerTurnSubmissionId: providerTurnSubmissionId(
      someAgentRunId, { kind: 'runtime-effect', source: 'skills-gate' }, EFFECT_KEY,
    ),
    deliveryAttemptOrdinal: 1,
    providerSessionId: mintProviderSessionId(),
    transcriptBindingId: deterministicId('transcriptBinding', ['nvk079']) as TranscriptBindingId,
    startTranscriptWatermark: null,
    expectedRunRecordVersion: RUN_VERSION,
    providerTurnId,
    activityGeneration: GENERATION,
    submissionEffectKey: EFFECT_KEY,
    inputDigest: digest(TEXT),
    utf8Text: TEXT,
    authority: {
      kind: 'runtime-safe-boundary',
      source: 'skills-gate',
      sourceEffectKey: EFFECT_KEY,
      sourceObjectRef: 'skills-gate:nvk079',
      expectedNoActiveInputLease: true,
      expectedNoControllerDraft: true,
    },
  }), 'prepare turn 1');
  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') throw new Error('unreachable');
  return { providerTurnId, attempt: prepared.attempt };
}

const execute = async (
  rig: Rig, providerTurnId: ReturnType<typeof mintProviderTurnId>,
  attempt: { id: string; recordVersion: RecordVersion },
) => rig.terminal.executeProviderTurnInput(runtimeContext(), {
  terminalInputAttemptId: attempt.id as never,
  expectedAttemptRecordVersion: attempt.recordVersion,
  submissionEffectKey: EFFECT_KEY,
  providerTurnId,
  activityGeneration: GENERATION,
  utf8Text: TEXT,
});

test('a session that has only fired its capability queries is refused, not written to', async () => {
  const rig = createRig({
    composer: true,
    providerInputReady: claudeInputReady,
    inputReadinessDeadlineMs: 300,
    inputReadinessPollMs: 30,
  });
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    // Exactly what the failing arms had painted when the product wrote: the
    // burst, and nothing else. 7 of 7 lost the turn here.
    rig.ptyHost.latest().emit(CAPABILITY_BURST);

    const { providerTurnId, attempt } = await prepareTurn(rig, session.id);
    const refused = expectError(await execute(rig, providerTurnId, attempt), 'execute turn 1');

    assert.equal(refused.code, 'ProviderInputNotReady');
    assert.deepEqual(rig.ptyHost.latest().written, [],
      'turn 1 was typed at a provider that had not proven it was reading');
    assert.deepEqual(rig.ptyHost.latest().turns, [], 'a turn reached the composer');

    // The reservation must be intact and honestly re-executable: nothing fired,
    // so this is not an "outcome uncertain" state and must not be recorded as
    // one. A retry after the composer arrives has to be able to send it.
    const still = unwrap(await rig.terminal.getProviderTurnInputAttempt(humanPrincipal(), {
      terminalSessionId: session.id,
      providerTurnId,
      submissionEffectKey: EFFECT_KEY,
    }), 'read the attempt back');
    assert.equal(still.effectState.kind, 'prepared');
    assert.equal(still.turnBarrier.kind, 'reserved-pre-effect');
  } finally {
    await rig.dispose();
  }
});

test('once the composer is painted the turn goes out whole: text, beat, then a lone CR', async () => {
  const rig = createRig({
    composer: true,
    providerInputReady: claudeInputReady,
    inputReadinessDeadlineMs: 5_000,
    inputReadinessPollMs: 20,
  });
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const pty = rig.ptyHost.latest();
    pty.emit(CAPABILITY_BURST);

    const { providerTurnId, attempt } = await prepareTurn(rig, session.id);
    // The composer arrives WHILE the gate is polling, which is the real
    // sequence: the CCLI finishes its handshake a second or so in.
    const painting = setTimeout(() => { pty.emit(COMPOSER); }, 120);
    const executed = unwrap(await execute(rig, providerTurnId, attempt), 'execute turn 1');
    clearTimeout(painting);

    assert.equal(executed.effectState.kind, 'submitted-confirmed');
    // The full delivery contract, unchanged by the gate: the turn as written,
    // then the submit key ALONE. A CR inside the burst is absorbed as text.
    assert.deepEqual(pty.written, [TEXT, '\r']);
    assert.deepEqual(pty.turns, [TEXT], 'the composer did not receive one whole turn');
  } finally {
    await rig.dispose();
  }
});

test('a session already proven to be reading does not pay the poll again', async () => {
  let asked = 0;
  const rig = createRig({
    composer: true,
    providerInputReady: async (_session, screen) => {
      asked += 1;
      return (screen.match(/─{8,}/gu) ?? []).length >= 2;
    },
    inputReadinessDeadlineMs: 5_000,
    inputReadinessPollMs: 20,
  });
  try {
    const session = unwrap(await openMockManagedSession(rig), 'open managed session');
    const pty = rig.ptyHost.latest();
    pty.emit(CAPABILITY_BURST + COMPOSER);

    const first = await prepareTurn(rig, session.id);
    unwrap(await execute(rig, first.providerTurnId, first.attempt), 'execute turn 1');
    const afterFirst = asked;
    assert.equal(afterFirst, 1, 'the first turn should be proven on its first look');

    // Turn 2 into a session that has already answered. A CLI does not
    // un-attach its stdin reader, so re-proving it would charge every later
    // turn for a race that only exists at startup.
    unwrap(await rig.terminal.settleProviderTurnCompletion(runtimeContext(), {
      terminalInputAttemptId: first.attempt.id,
      agentRunId: someAgentRunId,
      providerTurnId: first.providerTurnId,
      activityGeneration: GENERATION,
      transcriptTurnCompletionId: deterministicId(
        'transcriptTurnCompletion', ['nvk079'],
      ) as never,
      providerUsageEvidenceId: deterministicId(
        'providerUsageEvidence', ['nvk079'],
      ) as never,
    }), 'settle turn 1');

    const second = await prepareTurn(rig, session.id);
    unwrap(await execute(rig, second.providerTurnId, second.attempt), 'execute turn 2');
    assert.equal(asked, afterFirst, 'a proven session was re-polled for readiness');
    assert.deepEqual(pty.written, [TEXT, '\r', TEXT, '\r']);
  } finally {
    await rig.dispose();
  }
});

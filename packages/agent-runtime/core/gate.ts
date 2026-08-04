/* eslint-disable max-lines -- Gate orchestration is one atomic safe-boundary policy. */

// The carried-forward two-turn skills gate (B1-CF-001, §6.3, AMD-001 A-03).
//
// Chris's rule, from Build 1: an agent must confirm it has its skills BEFORE it
// does any work. B3b makes that structural rather than hopeful — the work
// instruction is held behind the operation fence and is only released by an
// exact, canonical confirmation.
//
// Three properties do the work:
//   - turn 1 contains task CONTEXT and the pinned skill references, and an
//     instruction to reply with one line and nothing else;
//   - the reply must be the EXACT set, sorted, no missing/extra/duplicate token;
//   - exactly one valid confirmation releases exactly one work turn, and replay
//     reads the transcript before sending, so a retry cannot send a second.
//
// Enforcement lives here, in the Runtime's spawn operation, and not in a
// provider hook — a hook is something a role can forget to install.
import { createHash } from 'node:crypto';
import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts } from '../contract/ports.js';
import type { CompleteProviderTurnOutcome } from '../contract/provider-turns.js';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import { advance, completed, effectKeyFor } from './journal.js';
import type { ProviderTurnCompletionCoordinator, RunsCore } from './runs-context.js';
import { requireRun } from './runs-context.js';
import { submitProviderTurn } from './provider-turns.js';
import { maybeAskAgain, noteStillness, startVigil } from './gate-vigil.js';
import {
  bearsFingerprint, plainText, sinceTheQuestion, withoutOurOwnWords,
} from './gate-screen.js';

export interface GateInput {
  readonly agentRun: AgentRun;
  readonly plan: LaunchPlanFacts;
  readonly operation: RunOperation;
  readonly brief: string;
  readonly supervised: boolean;
}

export interface GateOutcome {
  readonly agentRun: AgentRun;
  readonly operation: RunOperation;
}

/**
 * One token per pinned skill: `skill-id@v<version>#<digest>`. Sorted
 * lexicographically, so "the exact set" is a string comparison and not a
 * negotiation.
 */
/**
 * The separator two token lists are compared as strings with. Named, because a
 * quoted separator is a character nobody can see in a diff — and this file once
 * shipped a NUL byte in that position, which worked and read as a space.
 */
const TOKEN_SEPARATOR = '|';

export function canonicalTokens(plan: LaunchPlanFacts): readonly string[] {
  return plan.skills
    .map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Turn 1.
 *
 * It never spells the answer. A PTY echoes what is typed at it, so a prompt
 * that contained a valid `SKILLS-CONFIRMED:` line would be a confirmation the
 * gate typed to itself — the agent could stay silent and still pass. The tokens
 * are listed, the shape is described, and the one line that would satisfy the
 * gate is the one line only the agent can produce.
 */
export function confirmationPrompt(
  plan: LaunchPlanFacts, brief: string, turnRef: string,
): string {
  const tokens = canonicalTokens(plan);
  return [
    'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
    '',
    `TASK CONTEXT: ${brief}`,
    '',
    `Required skills, already resolved for you (${String(tokens.length)}, in this order):`,
    ...tokens.map((token, index) => `  ${String(index + 1)}. ${token}`),
    '',
    `Reply with EXACTLY ONE line and no other content: start it with ${marker(plan)}`,
    'then one space, then a JSON array of the tokens above, quoted, in the order',
    'listed. Nothing before the marker on that line, and nothing after the array.',
    '',
    promptFingerprint(turnRef),
  ].join('\n');
}

/**
 * The one string in turn 1 that only the Runtime could have written, and short
 * enough that no terminal width wraps it.
 *
 * A retry looks for THIS rather than for a confirmation, because "has this
 * session been asked" and "has this session answered" are different questions,
 * and on a session that echoes they look identical.
 */
export function promptFingerprint(turnRef: string): string {
  return `(novakai turn ${turnRef})`;
}

/** A short, stable name for one gate turn, derived from its own effect key. */
export function turnRefFor(effectKey: string): string {
  return createHash('sha256').update(effectKey, 'utf8').digest('hex').slice(0, 12);
}

function marker(plan: LaunchPlanFacts): string {
  return plan.skillsConfirmationGate.mode === 'required-two-turn'
    ? plan.skillsConfirmationGate.confirmationMarker : 'SKILLS-CONFIRMED:';
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Explicit frozen gate state transitions.
export async function runSkillsGate(
  core: RunsCore, context: CommandContext, input: GateInput,
): Promise<B3Result<GateOutcome>> {
  if (!input.supervised || input.plan.skillsConfirmationGate.mode !== 'required-two-turn') {
    // A chat launch has nothing to confirm. Recorded as `not-needed`, so the
    // ladder still shows the gate was considered and why it did not apply.
    return recordSkipped(core, input);
  }

  const sent = await sendConfirmationTurn(core, context, input);
  if (!sent.ok) return sent;
  let operation = sent.value.operation;

  const gateInput = { ...input, agentRun: sent.value.agentRun };
  const confirmed = await awaitConfirmation(
    core, context, gateInput, sent.value.paintedBefore, sent.value.startWatermark,
  );
  if (!confirmed.ok) {
    // A delivery failure is not skills drift, and must never be recorded as it.
    // `ProviderTurnNeverStarted` says the question never reached anyone; the
    // agent has not refused, disobeyed or answered wrongly, and publishing
    // `skills-gate.failed` over it convicts a session that was never asked.
    const failed = confirmed.error.code === 'ProviderTurnNeverStarted'
      ? await endRun(core, gateInput, 'agent.run.provider-turn.never-started', confirmed.error.message)
      : await endRun(core, gateInput, 'agent.run.skills-gate.failed', confirmed.error.message);
    return failed.ok ? confirmed : failed;
  }

  let completedGateRun = gateInput.agentRun;
  if (core.providerTurnCompletionCoordinator !== undefined) {
    const active = gateInput.agentRun.activeProviderTurn;
    const fence = gateInput.agentRun.providerTurnOperationFence;
    if (active === undefined || fence === undefined
      || active.providerTurnId !== fence.providerTurnId) {
      return b3fail(b3err('RecoveryRequired',
        'the confirmed gate turn has no exact semantic completion tuple', {
          operationId: operation.id, stage: 'skills-gate-confirmed',
          reason: 'missing-active-provider-turn',
        }, true));
    }
    const completedTurn = await settledCompletion(core, core.providerTurnCompletionCoordinator, {
      agentRunId: gateInput.agentRun.id,
      providerTurnId: active.providerTurnId,
      providerTurnSubmissionId: fence.providerTurnSubmissionId,
      activityGeneration: active.activityGeneration,
      traceId: context.traceId,
    });
    if (!completedTurn.ok) return completedTurn;
    if (completedTurn.value.kind !== 'completed'
      && completedTurn.value.kind !== 'already-completed-by-same-evidence') {
      return b3fail(b3err('RecoveryRequired',
        'the confirmed gate turn is not durably completed', {
          operationId: operation.id, stage: 'skills-gate-confirmed',
          reason: completedTurn.value.kind,
        }, true));
    }
    const refreshed = await requireRun(core, gateInput.agentRun.id);
    if (!refreshed.ok) return refreshed;
    completedGateRun = refreshed.value;
  }

  const passed = await advance(core, operation, {
    stage: 'skills-gate-confirmed', owner: 'agent-runtime',
  });
  if (!passed.ok) return passed;
  operation = passed.value;
  const announced = await core.publish('agent.run.skills-gate.passed', {
    agentRunId: input.agentRun.id, skills: canonicalTokens(input.plan),
  });
  if (!announced.ok) return b3fail(announced.error);

  const released = await releaseWorkTurn(core, context, {
    ...gateInput, agentRun: completedGateRun, operation,
  });
  if (!released.ok) return released;
  const current = await requireRun(core, gateInput.agentRun.id);
  return current.ok
    ? b3ok({ agentRun: current.value, operation: released.value })
    : current;
}

/**
 * How often the gate re-asks whether its confirmed turn has completed.
 *
 * The reconciler that commits the completion runs on its own ~1 s cadence, so
 * anything much finer is asking a question whose answer cannot have changed;
 * anything much coarser adds latency to a spawn that is otherwise done.
 */
const COMPLETION_POLL_MS = 250;

/** Could a later ask still turn this outcome into a completion? */
function stillSettling(outcome: CompleteProviderTurnOutcome): boolean {
  return outcome.kind !== 'completed'
    && outcome.kind !== 'already-completed-by-same-evidence'
    && outcome.retryable;
}

/**
 * The completion this gate turn already caused, waited for within a budget.
 *
 * Asking once was a race the gate could only lose. Durable completion is
 * committed by the reconciler, on its own cadence and after its own evidence
 * arrives — measured at 1–15 s from confirmation in the live spawn this fixes.
 * The gate asked on the tick the confirmation landed, got "the evidence has not
 * arrived", and refused `RecoveryRequired` — throwing away a spawn that had
 * already reached a real provider and got the exact canonical token set back,
 * because a clock had not caught up yet.
 *
 * What it does NOT do is wait out an outcome that says it is final.
 * `lineage-evidence-mismatch`, `target-changed` and `run-final` declare
 * themselves non-retryable, and re-asking them would only spend the budget
 * before reporting the answer already given. Only a self-declared retryable
 * outcome is worth another ask; when the budget runs out on one, it is refused
 * exactly as it was before, naming the outcome it gave up on.
 */
async function settledCompletion(
  core: RunsCore,
  coordinate: ProviderTurnCompletionCoordinator,
  request: Parameters<ProviderTurnCompletionCoordinator>[0],
): Promise<B3Result<CompleteProviderTurnOutcome>> {
  const deadline = core.clock() + core.gateCompletionBudgetMs;
  for (;;) {
    const outcome = await coordinate(request);
    if (!outcome.ok || !stillSettling(outcome.value)) return outcome;
    if (core.clock() >= deadline) return outcome;
    await new Promise((settle) => { setTimeout(settle, COMPLETION_POLL_MS); });
  }
}

async function recordSkipped(
  core: RunsCore, input: GateInput,
): Promise<B3Result<GateOutcome>> {
  let operation = input.operation;
  for (const stage of ['skills-gate-prompt-sent', 'skills-gate-confirmed', 'supervised-work-released'] as const) {
    const advanced = await advance(core, operation, {
      stage, owner: 'agent-runtime', outcome: 'not-needed',
      notNeededBecause: 'not applicable: this launch carries no supervised task',
    });
    if (!advanced.ok) return advanced;
    operation = advanced.value;
  }
  return b3ok({ agentRun: input.agentRun, operation });
}

interface SentTurn {
  readonly operation: RunOperation;
  readonly agentRun: AgentRun;
  /**
   * How much had been painted before turn 1 went out.
   *
   * The second anchor, and the one that holds when the first cannot: a provider
   * that does not echo leaves no fingerprint to find, and everything before this
   * offset is still, definitionally, not an answer to a question that had not
   * been asked yet.
   */
  readonly paintedBefore: number;
  /**
   * The binding's transcript watermark as turn 1 went out, or `undefined` when
   * this turn was sent by an EARLIER attempt and there is no "before" to compare
   * against. Only a turn this call actually submitted can be judged never to
   * have started; a resumed one may have been answered while nobody was looking.
   */
  readonly startWatermark?: string | null;
}

/**
 * Turn 1. Replay-safe by construction: the stage is recorded with its effect
 * key, so a retry that already sent it does not send it again (§13.5's "retry
 * observes transcript before sending again").
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- Preserves ordered prepare/execute/settle cuts.
async function sendConfirmationTurn(
  core: RunsCore, context: CommandContext, input: GateInput,
): Promise<B3Result<SentTurn>> {
  if (completed(input.operation, 'skills-gate-prompt-sent') !== null) {
    // An earlier attempt asked; its echo is the only anchor available now.
    const current = await requireRun(core, input.agentRun.id);
    return current.ok
      ? b3ok({ operation: input.operation, agentRun: current.value, paintedBefore: 0 })
      : current;
  }
  const terminalSessionId = input.agentRun.terminalSessionId;
  if (terminalSessionId === undefined) {
    return b3fail(b3err('RecoveryRequired',
      'the skills gate has no managed terminal to speak through',
      { operationId: input.operation.id, stage: 'skills-gate-prompt-sent', reason: 'no-terminal' },
      true));
  }

  // §13.5: "retry observes transcript before sending again". A crash between
  // submitting turn 1 and journalling it leaves a prompt the journal has no
  // record of; re-prompting would ask the same agent the same question twice.
  // Whatever it has already said is the evidence that it was asked.
  const effectKey = effectKeyFor(input.operation.id, 'skills-gate-prompt-sent');
  const before = await screenSoFar(core, terminalSessionId);
  if (!before.ok) return before;
  if (bearsFingerprint(before.value, promptFingerprint(turnRefFor(effectKey)))) {
    const advanced = await advance(core, input.operation, {
      stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
    });
    if (!advanced.ok) return advanced;
    const current = await requireRun(core, input.agentRun.id);
    return current.ok
      ? b3ok({ operation: advanced.value, agentRun: current.value, paintedBefore: 0 })
      : current;
  }

  const paintedBefore = before.value.length;
  const binding = await core.transcriptBinding?.(input.agentRun.id);
  if (binding === undefined || binding === null) {
    return b3fail(b3err('TranscriptSourceUnavailable',
      'the skills-gate turn requires its exact transcript binding', {
        agentRunId: input.agentRun.id, stage: 'skills-gate-prompt-sent',
      }, true));
  }
  const submitted = await submitProviderTurn(core, {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: deriveClientOpId(effectKey),
    traceId: context.traceId,
    contractVersion: 1,
    ...(core.fence.activeEpochId() === null
      ? {}
      : { runtimeEpochId: core.fence.activeEpochId()! }),
  }, {
    kind: 'runtime-effect',
    source: 'skills-gate',
    sourceEffectKey: effectKey,
    sourceObjectRef: input.operation.id,
    agentRunId: input.agentRun.id,
    terminalSessionId,
    transcriptBindingId: binding.bindingId,
    utf8Text: confirmationPrompt(input.plan, input.brief, turnRefFor(effectKey)),
  });
  if (!submitted.ok) return submitted;
  if (submitted.value.kind === 'queued-not-yet-safe') {
    return b3fail(b3err('ProviderTurnOperationInProgress',
      'the skills gate semantic turn is waiting for a safe input boundary', {
        agentRunId: input.agentRun.id, blocking: submitted.value.blocking,
      }, true));
  }
  const advanced = await advance(core, input.operation, {
    stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
  });
  if (!advanced.ok) return advanced;
  const current = await requireRun(core, input.agentRun.id);
  return current.ok
    ? b3ok({
        operation: advanced.value,
        agentRun: current.value,
        paintedBefore,
        startWatermark: binding.mirrorWatermark ?? null,
      })
    : current;
}

/**
 * What is on the screen right now, as a human would read it.
 *
 * Shared by the two questions the gate asks of a session — "has it already been
 * asked" (the prompt's own fingerprint coming back, the one string only the
 * Runtime could have put there) and "what has it said since". Both are answered
 * from the same bytes, so neither can drift from the other.
 */
async function screenSoFar(
  core: RunsCore, terminalSessionId: string,
): Promise<B3Result<string>> {
  const output = await core.terminal.readOutputSoFar(
    { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    terminalSessionId as never,
  );
  if (!output.ok) return output;
  return b3ok(plainText(output.value));
}

/**
 * Read what the provider actually SAID, until it says it or time runs out.
 *
 * "Said" is load-bearing. A PTY echoes, so the session's output contains the
 * Runtime's own turn 1 as well as the agent's reply, and a matcher handed the
 * raw stream cannot tell whose words it is judging. Everything the Runtime
 * typed is removed before anything is judged — so the only line that can pass
 * this gate is a line the Runtime did not write.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- One poll loop, two exact exits.
async function awaitConfirmation(
  core: RunsCore, context: CommandContext, input: GateInput, paintedBefore: number,
  startWatermark?: string | null,
): Promise<B3Result<string>> {
  const terminalSessionId = input.agentRun.terminalSessionId!;
  const mark = marker(input.plan);
  const deadline = core.clock() + core.gateTimeoutMs;
  const expected = canonicalTokens(input.plan);
  const ours = new Set(
    confirmationPrompt(
      input.plan, input.brief,
      turnRefFor(effectKeyFor(input.operation.id, 'skills-gate-prompt-sent')),
    ).split('\n').map((line) => line.trim()).filter((line) => line !== ''),
  );

  const effectKey = effectKeyFor(input.operation.id, 'skills-gate-prompt-sent');
  const fingerprint = promptFingerprint(turnRefFor(effectKey));
  const vigil = startVigil(core);

  /** The one line on this screen that could be an answer, or none. */
  const answerOn = (screen: string): string | null => {
    const reply = sinceTheQuestion(screen, fingerprint, paintedBefore);
    if (reply === null) return null;
    return core.providers.findConfirmationLine(
      input.plan.provider, withoutOurOwnWords(reply, ours), mark,
    );
  };

  const askedAt = core.clock();
  const grace = Math.min(PROVIDER_TURN_START_GRACE_MS, core.gateTimeoutMs / 4);

  for (;;) {
    const seen = await screenSoFar(core, terminalSessionId);
    if (!seen.ok) return seen;
    noteStillness(core, vigil, seen.value);
    const line = answerOn(seen.value);
    if (line !== null) return judge(line, mark, expected, input.agentRun.id);
    if (startWatermark !== undefined && core.clock() - askedAt >= grace) {
      const stalled = await neverStarted(core, input, {
        startWatermark, screen: seen.value, fingerprint,
      });
      if (stalled !== null) return b3fail(stalled);
    }
    if (core.clock() >= deadline) {
      return b3fail(skillsFailed(input.agentRun.id, 'no confirmation arrived before the gate timed out', []));
    }
    const again = await maybeAskAgain(core, context, {
      terminalSessionId,
      effectKey,
      keystrokes: core.providers.deliverTurn(
        input.plan.provider,
        confirmationPrompt(input.plan, input.brief, turnRefFor(effectKey)),
      ),
    }, vigil);
    if (!again.ok) return again;
    await new Promise((settle) => { setTimeout(settle, 100); });
  }
}

/**
 * How long a turn may show NO sign of having been received before the gate
 * stops waiting for an answer and says what it actually knows.
 *
 * Twenty seconds against measured receive latencies of 0.6–0.8 s from the write
 * (NVK-KIMI-078 §4) — roughly 25× the slowest observed — and a sixth of the
 * gate's own 120 s. Also capped at a quarter of whatever `gateTimeoutMs` is, so
 * a host that shortens the gate does not end up with a fast-fail that can never
 * fire before the deadline it was supposed to save.
 */
const PROVIDER_TURN_START_GRACE_MS = 20_000;

/**
 * Whether this turn provably never opened — or `null`, which means keep waiting.
 *
 * The failure being caught is exact: turn 1's bytes were destroyed before the
 * provider was reading, so the provider never saw a question. Two independent
 * things are true in that state and in no other:
 *
 *   - the binding's transcript watermark has not moved. The provider wrote no
 *     transcript AT ALL — verified by listing the session directory after two
 *     end-to-end repros and grepping every `*.jsonl` for the brief.
 *   - turn 1's own fingerprint is not on the screen. A tty echoes what is typed
 *     at it, so a turn that reached the session paints; the seven arms that lost
 *     theirs showed an idle composer with the placeholder still in it.
 *
 * BOTH, because either alone convicts something healthy: a provider that does
 * not echo has no fingerprint to find (which is why `paintedBefore` exists at
 * all), and a mirror that polls slowly has a watermark that legitimately lags.
 * A provider that neither echoed nor mirrored after the grace is one about
 * which nothing can honestly be claimed except that no turn started.
 */
async function neverStarted(
  core: RunsCore, input: GateInput,
  observed: {
    readonly startWatermark: string | null;
    readonly screen: string;
    readonly fingerprint: string;
  },
): Promise<ReturnType<typeof b3err> | null> {
  if (bearsFingerprint(observed.screen, observed.fingerprint)) return null;
  const binding = await core.transcriptBinding?.(input.agentRun.id);
  if (binding === undefined || binding === null) return null;
  const watermark = binding.mirrorWatermark ?? null;
  if (watermark !== observed.startWatermark) return null;
  return b3err('ProviderTurnNeverStarted',
    'the provider never started a turn: nothing was echoed and the transcript never moved',
    {
      agentRunId: input.agentRun.id,
      provider: input.plan.provider,
      transcriptBindingId: binding.bindingId,
      bindingState: binding.bindingState,
      startTranscriptWatermark: observed.startWatermark,
      currentTranscriptWatermark: watermark,
      attribution: 'delivery',
    }, true);
}

/**
 * The comparison §6.3 specifies: exact set, canonical order, no missing, extra
 * or duplicate token. Display names and path labels are explanatory only and
 * are never comparison keys.
 */
export function judge(
  line: string, marker: string, expected: readonly string[], agentRunId: string,
): B3Result<string> {
  const body = line.slice(line.indexOf(marker) + marker.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return b3fail(skillsFailed(agentRunId, 'the confirmation was not a JSON array', []));
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    return b3fail(skillsFailed(agentRunId, 'the confirmation was not an array of strings', []));
  }
  const confirmed = parsed as string[];
  if (confirmed.length === 0) {
    return b3fail(skillsFailed(agentRunId, 'an empty confirmation is never valid', []));
  }
  if (new Set(confirmed).size !== confirmed.length) {
    return b3fail(skillsFailed(agentRunId, 'the confirmation repeated a token', confirmed));
  }
  const sorted = [...confirmed].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (sorted.join(TOKEN_SEPARATOR) !== [...expected].join(TOKEN_SEPARATOR)) {
    return b3fail(skillsFailed(agentRunId,
      `the confirmation is not the pinned set (expected ${expected.length} token(s))`, confirmed));
  }
  if (confirmed.join(TOKEN_SEPARATOR) !== sorted.join(TOKEN_SEPARATOR)) {
    return b3fail(skillsFailed(agentRunId, 'the confirmation was not in canonical order', confirmed));
  }
  return b3ok(line);
}

/** Turn 2, sent once. The same effect key can never release a second. */
async function releaseWorkTurn(
  core: RunsCore, context: CommandContext, input: GateInput,
): Promise<B3Result<RunOperation>> {
  if (completed(input.operation, 'supervised-work-released') !== null) {
    return b3ok(input.operation);
  }
  const binding = await core.transcriptBinding?.(input.agentRun.id);
  if (binding !== undefined && binding !== null) {
    const effectKey = effectKeyFor(input.operation.id, 'supervised-work-released');
    const submitted = await submitProviderTurn(core, {
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: deriveClientOpId(effectKey),
      traceId: context.traceId,
      contractVersion: 1,
      ...(core.fence.activeEpochId() === null
        ? {}
        : { runtimeEpochId: core.fence.activeEpochId()! }),
    }, {
      kind: 'runtime-effect', source: 'supervised-work-release',
      sourceEffectKey: effectKey, sourceObjectRef: input.operation.id,
      agentRunId: input.agentRun.id,
      terminalSessionId: input.agentRun.terminalSessionId!,
      transcriptBindingId: binding.bindingId,
      utf8Text: workPrompt(input.brief),
    });
    if (!submitted.ok) return submitted;
    if (submitted.value.kind === 'queued-not-yet-safe') {
      return b3fail(b3err('ProviderTurnOperationInProgress',
        'the supervised work turn is waiting for a safe input boundary', {
          agentRunId: input.agentRun.id, blocking: submitted.value.blocking,
        }, true));
    }
    return advance(core, input.operation, {
      stage: 'supervised-work-released', owner: 'terminal',
      ownerObjectId: input.agentRun.terminalSessionId,
    });
  }
  return b3fail(b3err('TranscriptSourceUnavailable',
    'the supervised work turn requires its exact transcript binding', {
      agentRunId: input.agentRun.id, stage: 'supervised-work-released',
    }, true));
}

export function workPrompt(brief: string): string {
  return [
    'Skills confirmed. Begin the task now.',
    '',
    brief,
  ].join('\n');
}

/**
 * A failed gate terminates the Run. The work turn is NEVER sent — that is the
 * entire point of holding it behind the fence.
 *
 * WHICH event is published is the whole of the honesty here. Both outcomes end
 * the Run identically, because neither can proceed; only one of them is a
 * statement about the agent. `agent.run.skills-gate.failed` means an agent was
 * asked and its answer did not match the pinned set.
 * `agent.run.provider-turn.never-started` means nobody was asked anything, and
 * says so where every reader downstream can see it.
 */
async function endRun(
  core: RunsCore, input: GateInput, event: string, reason: string,
): Promise<B3Result<null>> {
  const failed = await core.store.update<AgentRun>(
    'sys_agent_runtime', input.agentRun.id,
    {
      lifecycle: 'failed', activity: 'idle',
      finalReason: 'unrecoverable-failure', finalAt: new Date().toISOString(),
    } as Record<string, unknown>,
    input.agentRun.recordVersion, context0(),
  );
  if (!failed.ok) return failed;
  const announced = await core.publish(event, {
    agentRunId: input.agentRun.id, reason,
  });
  if (!announced.ok) return b3fail(announced.error);
  return b3ok(null);
}

/** A fresh operation id for the terminating write; the command's own is spent. */
function context0(): Parameters<RunsCore['store']['update']>[4] {
  return `op_${crypto.randomUUID()}` as never;
}

export const skillsFailed = (
  agentRunId: string, reason: string, confirmedSkills: readonly string[],
): ReturnType<typeof b3err> => b3err('SkillsConfirmationFailed',
  `skills confirmation failed: ${reason}`,
  { agentRunId, reason, confirmedSkills }, false);

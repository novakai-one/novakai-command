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
  b3err, b3fail, b3ok,
  type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts } from '../contract/ports.js';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import { advance, completed, effectKeyFor } from './journal.js';
import type { RunsCore } from './runs-context.js';
import { maybeAskAgain, noteStillness, startVigil } from './gate-vigil.js';

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

/**
 * What a human would read off the screen: ANSI dressing removed, so a match is
 * about what was SAID and not about how the provider painted it.
 */
export function plainText(output: string): string {
  return output.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * The screen with the whitespace taken out, and a map back to where each
 * surviving character came from.
 *
 * A TUI does not type spaces. It moves the cursor to a column and paints the
 * next word, so once `plainText` has stripped those CSI sequences the words run
 * together: the re-probe read `(novakaiturnfb276bd5d5ba)` off a real session for
 * a fingerprint composed as `(novakai turn fb276bd5d5ba)`. Any anchor that has
 * to be FOUND on a real screen has to be looked for in this form.
 */
function compacted(text: string): { readonly text: string; readonly origin: readonly number[] } {
  let compact = '';
  const origin: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at]!;
    if (/\s/u.test(character)) continue;
    compact += character;
    origin.push(at);
  }
  return { text: compact, origin };
}

/**
 * Everything that arrived after turn 1 finished painting, or `null` if turn 1
 * has not appeared on the screen yet.
 *
 * This is the whole of the N-1 repair. The old gate subtracted "lines we typed"
 * from the screen, which works only against a session that echoes line for
 * line; against a composer that re-wraps, no row equals a line the Runtime
 * composed, every one of them survives the filter, and the marker sentence
 * inside the Runtime's OWN instructions gets read back as the agent's answer.
 *
 * Position is the property that cannot be reflowed away. The prompt ends with
 * its fingerprint — the one short string only the Runtime could have written —
 * so the last time that fingerprint appears is the last time turn 1 finished
 * being painted, and an answer to turn 1 can only be after it.
 */
export function afterPromptEcho(output: string, fingerprint: string): string | null {
  const screen = compacted(output);
  const needle = fingerprint.replace(/\s+/gu, '');
  const at = screen.text.lastIndexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length;
  return output.slice(screen.origin[end] ?? output.length);
}

function marker(plan: LaunchPlanFacts): string {
  return plan.skillsConfirmationGate.mode === 'required-two-turn'
    ? plan.skillsConfirmationGate.confirmationMarker : 'SKILLS-CONFIRMED:';
}

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

  const confirmed = await awaitConfirmation(core, context, input, sent.value.paintedBefore);
  if (!confirmed.ok) {
    const failed = await failGate(core, input, confirmed.error.message);
    return failed.ok ? confirmed : failed;
  }

  const passed = await advance(core, operation, {
    stage: 'skills-gate-confirmed', owner: 'agent-runtime',
  });
  if (!passed.ok) return passed;
  operation = passed.value;
  core.publish('agent.run.skills-gate.passed', {
    agentRunId: input.agentRun.id, skills: canonicalTokens(input.plan),
  });

  const released = await releaseWorkTurn(core, context, { ...input, operation });
  if (!released.ok) return released;
  return b3ok({ agentRun: input.agentRun, operation: released.value });
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
  /**
   * How much had been painted before turn 1 went out.
   *
   * The second anchor, and the one that holds when the first cannot: a provider
   * that does not echo leaves no fingerprint to find, and everything before this
   * offset is still, definitionally, not an answer to a question that had not
   * been asked yet.
   */
  readonly paintedBefore: number;
}

/**
 * Turn 1. Replay-safe by construction: the stage is recorded with its effect
 * key, so a retry that already sent it does not send it again (§13.5's "retry
 * observes transcript before sending again").
 */
async function sendConfirmationTurn(
  core: RunsCore, context: CommandContext, input: GateInput,
): Promise<B3Result<SentTurn>> {
  if (completed(input.operation, 'skills-gate-prompt-sent') !== null) {
    // An earlier attempt asked; its echo is the only anchor available now.
    return b3ok({ operation: input.operation, paintedBefore: 0 });
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
  if (before.value.includes(promptFingerprint(turnRefFor(effectKey)))
    || compacted(before.value).text.includes(
      promptFingerprint(turnRefFor(effectKey)).replace(/\s+/gu, ''))) {
    const advanced = await advance(core, input.operation, {
      stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
    });
    return advanced.ok ? b3ok({ operation: advanced.value, paintedBefore: 0 }) : advanced;
  }

  const paintedBefore = before.value.length;
  const submitted = await core.terminal.submitRuntimeInput(context, {
    terminalSessionId,
    keystrokes: core.providers.deliverTurn(
      input.plan.provider,
      confirmationPrompt(input.plan, input.brief, turnRefFor(effectKey)),
    ),
    effectKey,
  });
  if (!submitted.ok) return submitted;
  const advanced = await advance(core, input.operation, {
    stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
  });
  return advanced.ok ? b3ok({ operation: advanced.value, paintedBefore }) : advanced;
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
async function awaitConfirmation(
  core: RunsCore, context: CommandContext, input: GateInput, paintedBefore: number,
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

  for (;;) {
    const seen = await screenSoFar(core, terminalSessionId);
    if (!seen.ok) return seen;
    noteStillness(core, vigil, seen.value);
    const reply = sinceTheQuestion(seen.value, fingerprint, paintedBefore);
    const line = reply === null ? null : core.providers.findConfirmationLine(
      input.plan.provider, withoutOurOwnWords(reply, ours), mark,
    );
    if (line !== null) return judge(line, mark, expected, input.agentRun.id);
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
 * The part of the screen that can possibly be an answer to turn 1.
 *
 * Two anchors, and the later one wins. The prompt's echo is the stronger — it
 * ends exactly where the Runtime stopped speaking — and it survives a reflow
 * because it is found in the whitespace-free form. Where a provider does not
 * echo at all there is nothing to find, and the fallback is the offset the
 * screen stood at when turn 1 went out.
 *
 * A screen that has neither is a screen where nothing that could be an answer
 * has arrived, and the honest verdict there is silence, not a guess.
 */
function sinceTheQuestion(
  screen: string, fingerprint: string, paintedBefore: number,
): string | null {
  const afterEcho = afterPromptEcho(screen, fingerprint);
  if (afterEcho !== null) return afterEcho;
  if (screen.length <= paintedBefore) return null;
  return screen.slice(paintedBefore);
}

/** Drop every line the Runtime itself typed at this session. */
function withoutOurOwnWords(output: string, ours: ReadonlySet<string>): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !ours.has(line.trim()))
    .join('\n');
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
  const submitted = await core.terminal.submitRuntimeInput(context, {
    terminalSessionId: input.agentRun.terminalSessionId!,
    keystrokes: core.providers.deliverTurn(input.plan.provider, workPrompt(input.brief)),
    effectKey: effectKeyFor(input.operation.id, 'supervised-work-released'),
  });
  if (!submitted.ok) return submitted;
  return advance(core, input.operation, {
    stage: 'supervised-work-released', owner: 'terminal',
    ownerObjectId: input.agentRun.terminalSessionId,
  });
}

export function workPrompt(brief: string): string {
  return [
    'Skills confirmed. Begin the task now.',
    '',
    brief,
  ].join('\n');
}

/**
 * A failed gate terminates the Run and records drift. The work turn is NEVER
 * sent — that is the entire point of holding it behind the fence.
 */
async function failGate(
  core: RunsCore, input: GateInput, reason: string,
): Promise<B3Result<null>> {
  core.publish('agent.run.skills-gate.failed', { agentRunId: input.agentRun.id, reason });
  const failed = await core.store.update<AgentRun>(
    'sys_agent_runtime', input.agentRun.id,
    {
      lifecycle: 'failed', activity: 'idle',
      finalReason: 'unrecoverable-failure', finalAt: new Date().toISOString(),
    } as Record<string, unknown>,
    input.agentRun.recordVersion, context0(),
  );
  if (!failed.ok) return failed;
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

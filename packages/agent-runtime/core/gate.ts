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
import {
  b3err, b3fail, b3ok,
  type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts } from '../contract/ports.js';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import { advance, completed, effectKeyFor } from './journal.js';
import type { RunsCore } from './runs-context.js';

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

export function confirmationPrompt(plan: LaunchPlanFacts, brief: string): string {
  const tokens = canonicalTokens(plan);
  return [
    'You are a governed Novakai agent. Your task follows, but do NOT begin it yet.',
    '',
    `TASK CONTEXT: ${brief}`,
    '',
    'Required skills, already resolved for you:',
    ...tokens.map((token) => `  - ${token}`),
    '',
    'Reply with EXACTLY ONE line and no other content:',
    `SKILLS-CONFIRMED: ${JSON.stringify(tokens)}`,
  ].join('\n');
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
  let operation = sent.value;

  const confirmed = await awaitConfirmation(core, input);
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

/**
 * Turn 1. Replay-safe by construction: the stage is recorded with its effect
 * key, so a retry that already sent it does not send it again (§13.5's "retry
 * observes transcript before sending again").
 */
async function sendConfirmationTurn(
  core: RunsCore, context: CommandContext, input: GateInput,
): Promise<B3Result<RunOperation>> {
  if (completed(input.operation, 'skills-gate-prompt-sent') !== null) {
    return b3ok(input.operation);
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
  const spoken = await alreadyPrompted(core, input, terminalSessionId);
  if (!spoken.ok) return spoken;
  if (spoken.value) {
    return advance(core, input.operation, {
      stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
    });
  }

  const submitted = await core.terminal.submitRuntimeInput(context, {
    terminalSessionId,
    text: core.providers.submitTurn(
      input.plan.provider, confirmationPrompt(input.plan, input.brief),
    ),
    effectKey: effectKeyFor(input.operation.id, 'skills-gate-prompt-sent'),
  });
  if (!submitted.ok) return submitted;
  return advance(core, input.operation, {
    stage: 'skills-gate-prompt-sent', owner: 'terminal', ownerObjectId: terminalSessionId,
  });
}

/**
 * Whether this session has already been asked. The evidence is the session's
 * own output carrying the marker — which is what a re-entering attempt can see
 * and a lost in-memory record cannot.
 */
async function alreadyPrompted(
  core: RunsCore, input: GateInput, terminalSessionId: string,
): Promise<B3Result<boolean>> {
  const output = await core.terminal.readOutputSoFar(
    { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    terminalSessionId as never,
  );
  if (!output.ok) return output;
  const marker = input.plan.skillsConfirmationGate.mode === 'required-two-turn'
    ? input.plan.skillsConfirmationGate.confirmationMarker : 'SKILLS-CONFIRMED:';
  return b3ok(core.providers.findConfirmationLine(
    input.plan.provider, output.value, marker,
  ) !== null);
}

/** Read what the provider actually said, until it says it or time runs out. */
async function awaitConfirmation(
  core: RunsCore, input: GateInput,
): Promise<B3Result<string>> {
  const terminalSessionId = input.agentRun.terminalSessionId!;
  const marker = input.plan.skillsConfirmationGate.mode === 'required-two-turn'
    ? input.plan.skillsConfirmationGate.confirmationMarker : 'SKILLS-CONFIRMED:';
  const deadline = core.clock() + core.gateTimeoutMs;
  const expected = canonicalTokens(input.plan);

  for (;;) {
    const output = await core.terminal.readOutputSoFar(
      { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] }, terminalSessionId,
    );
    if (!output.ok) return output;
    const line = core.providers.findConfirmationLine(
      input.plan.provider, output.value, marker,
    );
    if (line !== null) return judge(line, marker, expected, input.agentRun.id);
    if (core.clock() >= deadline) {
      return b3fail(skillsFailed(input.agentRun.id, 'no confirmation arrived before the gate timed out', []));
    }
    await new Promise((settle) => { setTimeout(settle, 100); });
  }
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
    text: core.providers.submitTurn(input.plan.provider, workPrompt(input.brief)),
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

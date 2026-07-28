// packages/server/core/supervision/gate.ts — the SKILLS-CONFIRMATION gate
// (DEC-B1-10, ruled two-turn for supervised spawns by §13 SEVERE-3).
//
// > [Chris, verbatim 2026-07-28 13:32] "…you MUST ENSURE THE AGENTS have SKILLS
// > Applied… Before any work THEY MUST confirm back to you that they have them
// > applied… the SUBAGENTS must also have skills applied -> SO YOU WILL be in
// > charge and responsible…"
//
// The gate is the mechanism that makes "before any work" a fact rather than a
// hope. Turn 1 carries the skill paths and demands ONE literal line back. The
// engine validates it. Only a valid marker unlocks turn 2 (the work brief); an
// invalid one terminates the session and emits a drift event, and the work
// brief is never sent at all.
//
// This module is the DECIDING half, kept pure on purpose: given the text an
// agent replied, did it confirm? No I/O, no clock, no session — so the rule
// that guards every supervised spawn is testable in microseconds and cannot
// drift with the orchestration around it.

/** The literal markers (§13 disposition 9). Literal means literal. */
export const SKILLS_MARKER = 'SKILLS-CONFIRMED:';
export const SUBAGENT_MARKER = 'SUBAGENT-SKILLS:';
export const TASK_COMPLETE_MARKER = 'TASK-COMPLETE';

export type GateFailure =
  | 'no-reply'              // the agent said nothing
  | 'no-marker'             // it talked, but never used the marker
  | 'marker-not-first-line' // it used the marker, but buried it under prose
  | 'empty-skill-list';     // it used the marker and named nothing

export type SkillsMarkerResult =
  | { ok: true; confirmed: string[] }
  | { ok: false; reason: GateFailure; confirmed: [] };

const fail = (reason: GateFailure): SkillsMarkerResult => ({ ok: false, reason, confirmed: [] });

/**
 * Validate an agent's turn-1 reply against the ruled marker format.
 *
 * The rule is deliberately unforgiving. Every softening ("accept it anywhere",
 * "accept lowercase", "accept **bold**") converts the gate back into what it
 * replaced — an agent that SAYS it read the skills. A near-miss is a refusal,
 * and the agent gets terminated and restarted, which costs one cheap turn.
 */
export function validateSkillsMarker(reply: string): SkillsMarkerResult {
  if (!reply || !reply.trim()) return fail('no-reply');
  const lines = reply.split('\n');
  const firstContentLine = lines.find((line) => line.trim().length > 0) ?? '';
  if (!firstContentLine.trimStart().startsWith(SKILLS_MARKER)) {
    // Distinguish "never used it" from "used it in the wrong place": the two
    // failures need different corrections, so they are reported differently.
    return fail(reply.includes(SKILLS_MARKER) ? 'marker-not-first-line' : 'no-marker');
  }
  const named = firstContentLine.trimStart().slice(SKILLS_MARKER.length);
  const confirmed = [...new Set(
    named.split(',').map((name) => name.trim()).filter((name) => name.length > 0),
  )];
  if (confirmed.length === 0) return fail('empty-skill-list');
  return { ok: true, confirmed };
}

/**
 * The subagent cascade (§13 disposition 9). Unlike the gate marker this one may
 * appear anywhere in a work update — it accompanies work rather than gating it.
 */
export function hasSubagentSkillsStatement(text: string): boolean {
  return text.includes(SUBAGENT_MARKER);
}

/** Task completion trigger 1 of 2 (§13 disposition 8); the other is idle timeout. */
export function declaresTaskComplete(text: string): boolean {
  return text.includes(TASK_COMPLETE_MARKER);
}

export interface GatePromptInput {
  /** The work brief. NOT sent on turn 1 — held until the marker validates. */
  brief: string;
  /** Absolute paths to the skill files the agent must read. */
  skillPaths: string[];
}

/**
 * Turn 1: the cheap instruction. It carries the paths and asks for the marker
 * and nothing else, so a failed gate costs one short turn rather than a whole
 * briefed one.
 */
export function buildGatePrompt(input: GatePromptInput): string {
  void input.brief; // deliberately unused on turn 1 — see the module header
  const paths = input.skillPaths.map((p) => `  - ${p}`).join('\n');
  return [
    'Before any work: read these skill files in full.',
    paths,
    '',
    `Then reply with ONLY this one line, first line, exactly: ${SKILLS_MARKER} <comma-separated skill names>`,
    'No preamble, no summary, no plan yet. Any other shape ends this session.',
    '',
    'If you later spawn subagents, they inherit this requirement, and every work'
    + ` update you send must state how you ensured it, on a line beginning ${SUBAGENT_MARKER}`,
    `When your task is finished, end your final message with ${TASK_COMPLETE_MARKER}`,
  ].join('\n');
}

/** Turn 2: sent ONLY after a valid marker. */
export function buildWorkPrompt(input: GatePromptInput & { confirmed: string[] }): string {
  return [
    `Skills confirmed on record: ${input.confirmed.join(', ')}. Begin the task.`,
    '',
    input.brief,
  ].join('\n');
}

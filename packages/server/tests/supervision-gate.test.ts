// B1b slice 5a — the SKILLS-CONFIRMATION gate (DEC-B1-10, §13 SEVERE-3).
//
// Chris's verbatim requirement is that agents confirm their skills BEFORE any
// work. The gate disposition makes that enforceable rather than hopeful: turn 1
// is the brief plus a demand for a literal first-line marker, the engine
// VALIDATES the marker, and a session that fails is terminated with NO work
// turn ever sent. These tests pin the validator — the half that decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSkillsMarker, hasSubagentSkillsStatement, declaresTaskComplete, buildGatePrompt,
} from '../core/supervision/gate.js';

/** Narrow the result union: a pass has no reason to report. */
const reasonOf = (reply: string): string => {
  const res = validateSkillsMarker(reply);
  return res.ok ? 'passed' : res.reason;
};

test('the canonical reply passes and reports the named skills', () => {
  const res = validateSkillsMarker('SKILLS-CONFIRMED: elite-codebase-engineering, tdd, handoff');
  assert.equal(res.ok, true);
  assert.deepEqual(res.confirmed, ['elite-codebase-engineering', 'tdd', 'handoff']);
});

test('leading blank lines are tolerated — the marker must be the first CONTENT line', () => {
  const res = validateSkillsMarker('\n\n   \nSKILLS-CONFIRMED: tdd\n');
  assert.equal(res.ok, true);
  assert.deepEqual(res.confirmed, ['tdd']);
});

test('a marker buried under prose FAILS — first line is the rule, not a preference', () => {
  assert.equal(
    reasonOf("Sure! I've read them all and I'm ready.\nSKILLS-CONFIRMED: tdd, handoff"),
    'marker-not-first-line');
});

test('an enthusiastic reply with no marker at all FAILS', () => {
  assert.equal(reasonOf('Skills applied! Ready to build.'), 'no-marker');
});

test('a marker naming NOTHING fails — "confirmed" without content is not a confirmation', () => {
  assert.equal(reasonOf('SKILLS-CONFIRMED:'), 'empty-skill-list');
  assert.equal(reasonOf('SKILLS-CONFIRMED:    '), 'empty-skill-list');
  assert.equal(reasonOf('SKILLS-CONFIRMED: , ,'), 'empty-skill-list');
});

test('an empty or whitespace-only reply fails as no-reply, distinctly from a bad marker', () => {
  assert.equal(reasonOf(''), 'no-reply');
  assert.equal(reasonOf('   \n  '), 'no-reply');
});

test('the marker is matched literally: near-misses are refusals, not near-passes', () => {
  assert.equal(validateSkillsMarker('skills-confirmed: tdd').ok, false, 'case is part of the literal');
  assert.equal(validateSkillsMarker('SKILLS CONFIRMED: tdd').ok, false, 'the hyphen is part of the literal');
  assert.equal(validateSkillsMarker('**SKILLS-CONFIRMED:** tdd').ok, false, 'markdown dressing is not the marker');
});

test('extra lines after a valid marker are allowed — the plan may follow the confirmation', () => {
  const res = validateSkillsMarker('SKILLS-CONFIRMED: tdd\n\nPlan:\n1. write a failing test');
  assert.equal(res.ok, true);
  assert.deepEqual(res.confirmed, ['tdd']);
});

test('duplicate skill names are collapsed — the list is a set of what was applied', () => {
  const res = validateSkillsMarker('SKILLS-CONFIRMED: tdd, tdd, handoff');
  assert.deepEqual(res.confirmed, ['tdd', 'handoff']);
});

// ── the cascade + completion markers (§13 disposition 9) ───────────────────

test('the subagent cascade is detected by its own literal marker', () => {
  assert.equal(hasSubagentSkillsStatement('SUBAGENT-SKILLS: each dispatch carried the five paths'), true);
  assert.equal(hasSubagentSkillsStatement('work update\nSUBAGENT-SKILLS: n/a — none spawned'), true,
    'unlike the gate marker, this one may appear anywhere in a work update');
  assert.equal(hasSubagentSkillsStatement('I told the subagents about skills'), false,
    'a claim in prose is not the marker — that is the whole point of a marker');
});

test('task completion is declared by the TASK-COMPLETE marker', () => {
  assert.equal(declaresTaskComplete('all done\nTASK-COMPLETE'), true);
  assert.equal(declaresTaskComplete('TASK-COMPLETE'), true);
  assert.equal(declaresTaskComplete('the task is complete'), false,
    'idle timeout is the OTHER completion trigger; prose is neither');
});

// ── the demand itself ──────────────────────────────────────────────────────

test('the gate prompt names the skill files and demands ONLY the marker', () => {
  const prompt = buildGatePrompt({
    brief: 'Build the widget.',
    skillPaths: ['/a/tdd/SKILL.md', '/b/handoff/SKILL.md'],
  });
  assert.match(prompt, /\/a\/tdd\/SKILL\.md/);
  assert.match(prompt, /\/b\/handoff\/SKILL\.md/);
  assert.match(prompt, /SKILLS-CONFIRMED:/);
  assert.doesNotMatch(prompt, /Build the widget\./,
    'turn 1 is the DEMAND — the work brief is only sent after the marker validates');
});

test('the gate prompt still cascades the subagent demand', () => {
  const prompt = buildGatePrompt({ brief: 'x', skillPaths: ['/a/tdd/SKILL.md'] });
  assert.match(prompt, /SUBAGENT-SKILLS:/,
    'Chris made the supervising agent responsible for its subagents — say so up front');
});

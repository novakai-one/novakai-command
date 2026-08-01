// The gate, against a screen that reflows (NVK-KIMI-030 N-1).
//
// Every other gate test drives a session that echoes back exactly what it was
// handed, line for line. Real provider TUIs do not. The claude composer takes
// the turn as one long line, re-wraps it at the window width, and paints each
// word at an explicit cursor column — so after `plainText` strips the CSI
// sequences the Runtime's own instructions are still on screen, in rows that
// match nothing the Runtime composed.
//
// The re-probe watched that kill 9 of 13 governed spawns and 3 of 3 governed
// continuations in about four seconds each, before the agent had said anything:
// the wrap landed on `SKILLS-CONFIRMED:`, the gate read its own sentence back,
// judged it, found it was not JSON, terminated the Run, and recorded skills
// drift against an agent that never spoke.
//
// The property these tests hold is one sentence: only what arrived AFTER turn 1
// was submitted can be an answer to turn 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRoleProfileId } from '@novakai/foundation/contract';
import { createRunsRig, type RunsRig } from '../runs-harness.js';

/** The width the re-probe measured a real claude composer wrapping at. */
const TUI_COLUMNS = 120;

const spawnInput = (roleProfileId: AgentRoleProfileId, brief: string) => ({
  roleProfileId,
  displayName: 'Governed',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief },
});

async function withReflowingTui<T>(
  work: (rig: RunsRig) => Promise<T>,
): Promise<T> {
  const rig = createRunsRig({ gateTimeoutMs: 900 });
  rig.terminal.reflowColumns = TUI_COLUMNS;
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

/**
 * The briefs the re-probe swept. Length is the whole variable: it decides where
 * the wrap boundary falls, and three of these four put a row boundary exactly
 * at the marker. A fix that works for one brief and not the others has not
 * fixed anything.
 */
const BRIEFS = [
  'Reply OK.',
  'Say IDEM once, then stop.',
  'Say the word BANANA once, then stop.',
  'Say ZULU once, then stop and do nothing else at all.',
];

test('a silent agent is never convicted on the gate\'s own words', async () => {
  for (const brief of BRIEFS) {
    await withReflowingTui(async (rig) => {
      const role = rig.agents.defineRole('governed');
      rig.terminal.reply = 'silent';

      const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, brief));
      assert.equal(spawned.ok, false, `a silent agent passed the gate (brief: ${brief})`);
      if (spawned.ok) return;
      assert.equal(spawned.error.code, 'SkillsConfirmationFailed');
      // The honest verdict for a session that said nothing is "nothing arrived".
      // "The confirmation was not a JSON array" is a verdict about a
      // confirmation, and there was none — it is the Runtime reading itself.
      assert.equal(
        spawned.error.message.includes('no confirmation arrived'), true,
        `the gate judged its own prompt (brief: ${brief}): ${spawned.error.message}`,
      );
    });
  }
});

test('a governed spawn still reaches ready on a screen that reflows', async () => {
  for (const brief of BRIEFS) {
    await withReflowingTui(async (rig) => {
      const role = rig.agents.defineRole('governed');
      const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role, brief));
      assert.equal(spawned.ok, true,
        `a correct confirmation was refused (brief: ${brief}): ${
          spawned.ok ? '' : spawned.error.message}`);
      if (!spawned.ok) return;
      assert.equal(spawned.value.run.lifecycle, 'ready');
      // Two turns, exactly: the question, then the work it was holding.
      assert.equal(rig.terminal.submitted.length, 2);
    });
  }
});

test('a governed CONTINUATION survives the same screen', async () => {
  // The re-probe's other half: 0 of 3 governed continuations reached ready,
  // including one whose original spawn had passed with the same task text.
  // `continue --mode fresh` re-runs the gate with a differently composed brief,
  // so it wraps at a different place and dies just as reliably.
  await withReflowingTui(async (rig) => {
    const role = rig.agents.defineRole('governed');
    const spawned = await rig.runtime.spawnAgent(
      rig.human(), spawnInput(role, 'Say the word BANANA once, then stop.'),
    );
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    const continued = await rig.runtime.continueAgent(rig.human(), {
      agentId: spawned.value.run.agentId,
      expectedOldRunId: spawned.value.run.id,
      mode: 'fresh',
      configurationMode: 'inherit-plan',
    });
    assert.equal(continued.ok, true,
      `a governed continuation died at the gate: ${
        continued.ok ? '' : continued.error.message}`);
    if (continued.ok) assert.equal(continued.value.run.lifecycle, 'ready');
  });
});

test('the gate cannot be passed by a confirmation that predates the question', async () => {
  // The other direction of the same rule. A line already on screen before turn 1
  // was submitted is not an answer to turn 1 — it is scrollback, or a previous
  // Run's transcript, or something the operator pasted.
  await withReflowingTui(async (rig) => {
    const role = rig.agents.defineRole('governed');
    rig.terminal.reply = 'silent';
    rig.terminal.output = `SKILLS-CONFIRMED: ${JSON.stringify(rig.terminal.pinnedTokens)}\n`;

    const spawned = await rig.runtime.spawnAgent(
      rig.human(), spawnInput(role, 'Say IDEM once, then stop.'),
    );
    assert.equal(spawned.ok, false,
      'a confirmation printed before the gate ever asked released the work turn');
    if (!spawned.ok) assert.equal(spawned.error.code, 'SkillsConfirmationFailed');
  });
});

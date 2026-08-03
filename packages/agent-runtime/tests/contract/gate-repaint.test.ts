// The gate, against a screen that REPAINTS (NVK-048 class 6, NVK-KIMI-054).
//
// `gate-echo.test.ts` next door holds the property that only what arrived after
// turn 1 can be an answer to turn 1. This file holds a different one, and the
// two are independent: whatever the reader decides to judge, it must judge the
// characters the agent actually put on the screen.
//
// A TUI redrawing a row it has already drawn steps the cursor over the columns
// that are already correct and paints only the runs that changed. A reader that
// deletes the cursor jump glues the surviving runs together and deletes every
// character that was stepped over. NVK-048 measured a verbatim-correct
// confirmation rejected ~1 spawn in 3 that way, and `p10` recorded the shape:
//
//   reason: "the confirmation is not the pinned set (expected 1 token(s))"
//   confirmedSkills: ["nvk048-skll@v1#d0"]        // pinned: nvk048-sk_i_ll
//
// The Run was terminated and skills drift recorded against an agent that had
// answered correctly. That is the worst failure this gate has: it is not a
// missed confirmation, it is a false conviction.
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

/** Two pinned skills, so every way of answering wrong is a distinct answer. */
const SKILLS = [
  { id: 'elite-codebase-engineering', version: 3, digest: 'a1b2c3d4' },
  { id: 'test-driven-development', version: 2, digest: 'e5f6a7b8' },
];

async function withRepaintingTui<T>(work: (rig: RunsRig) => Promise<T>): Promise<T> {
  const rig = createRunsRig({ gateTimeoutMs: 900, skills: SKILLS });
  rig.terminal.reflowColumns = TUI_COLUMNS;
  rig.terminal.repaintAnswer = true;
  try {
    return await work(rig);
  } finally {
    rig.close();
  }
}

/** The same four briefs `gate-echo` sweeps: length moves the wrap boundary. */
const BRIEFS = [
  'Reply OK.',
  'Say IDEM once, then stop.',
  'Say the word BANANA once, then stop.',
  'Say ZULU once, then stop and do nothing else at all.',
];

test('a correct confirmation survives the row it was painted on being redrawn', async () => {
  for (const brief of BRIEFS) {
    await withRepaintingTui(async (rig) => {
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

test('a repainted screen still convicts an agent that answers wrong', async () => {
  // The other direction, and the reason this cannot be fixed by being lenient:
  // recovering the stepped-over characters must recover what the agent SAID,
  // not repair it into what the gate wanted to hear.
  for (const reply of ['missing-token', 'out-of-order', 'extra-token', 'duplicate-token'] as const) {
    await withRepaintingTui(async (rig) => {
      const role = rig.agents.defineRole('governed');
      rig.terminal.reply = reply;

      const spawned = await rig.runtime.spawnAgent(
        rig.human(), spawnInput(role, 'Say IDEM once, then stop.'),
      );
      assert.equal(spawned.ok, false, `a ${reply} reply passed the gate`);
      if (spawned.ok) return;
      assert.equal(spawned.error.code, 'SkillsConfirmationFailed');
      // And it was judged on its answer, not timed out on a screen it could
      // not read: silence and drift are different verdicts.
      assert.equal(
        spawned.error.message.includes('no confirmation arrived'), false,
        `a ${reply} reply timed out instead of being judged: ${spawned.error.message}`,
      );
    });
  }
});

// The gate tells a delivery failure from skills drift (NVK-KIMI-079, part 2).
//
// The measured failure (NVK-KIMI-078): turn 1's bytes were written into a
// claude that was still parsing its own capability queries, so they were
// destroyed. No provider turn opened, no transcript line was written, and the
// gate then polled a screen that could never change until its 120 s deadline —
// after which it reported `SkillsConfirmationFailed … no confirmation arrived`,
// terminated the Run, and published `agent.run.skills-gate.failed`.
//
// Two things were wrong with that, and only one of them is the delay. The
// verdict was about the AGENT: a session that was never asked anything is
// recorded, permanently, as having failed to confirm its skills. Every reader
// downstream — the ladder, the tree surface, whoever reads the event — sees an
// agent that drifted.
//
// So the gate now separates the two, and the control below is as load-bearing
// as the subject: an agent that WAS asked and said nothing must still be
// skills-drift, or this fix has simply moved the misattribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRoleProfileId } from '@novakai/foundation/contract';
import { createRunsRig } from '../runs-harness.js';

const GATE_TIMEOUT_MS = 4_000;

const spawnInput = (roleProfileId: AgentRoleProfileId) => ({
  roleProfileId,
  displayName: 'Governed',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'Reply OK.' },
});

test('a turn that never opened fails fast, typed, and is never recorded as skills drift', async () => {
  const rig = createRunsRig({ gateTimeoutMs: GATE_TIMEOUT_MS });
  try {
    const role = rig.agents.defineRole('governed');
    // Written by Terminal, received by nobody: nothing echoes, nothing answers,
    // the transcript watermark never moves.
    rig.terminal.reply = 'destroyed';

    const startedAt = Date.now();
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(spawned.ok, false, 'a spawn whose turn never opened reported success');
    if (spawned.ok) return;
    assert.equal(spawned.error.code, 'ProviderTurnNeverStarted');
    assert.equal(spawned.error.details['attribution'], 'delivery');
    assert.equal(spawned.error.retryable, true,
      'a delivery failure the operator can retry was reported as permanent');

    // Fast, not eventual. The old path spent the entire gate deadline to learn
    // something that was already true after the grace.
    assert.ok(elapsedMs < GATE_TIMEOUT_MS,
      `the gate spent ${String(elapsedMs)}ms of its ${String(GATE_TIMEOUT_MS)}ms deadline`);

    const kinds = rig.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.skills-gate.failed'), false,
      'a session that was never asked was recorded as having failed its skills gate');
    assert.equal(kinds.includes('agent.run.provider-turn.never-started'), true,
      'the delivery failure was not announced at all');
    assert.equal(kinds.includes('agent.run.skills-gate.passed'), false);

    // The work turn is still held. Exactly one turn was ever submitted.
    assert.equal(rig.terminal.submitted.length, 1);
  } finally {
    rig.close();
  }
});

test('an agent that WAS asked and said nothing is still skills drift', async () => {
  const rig = createRunsRig({ gateTimeoutMs: GATE_TIMEOUT_MS });
  try {
    const role = rig.agents.defineRole('governed');
    // Echoed — so the question demonstrably reached the session — and then
    // silence. This is the agent's failure, and it must stay the agent's.
    rig.terminal.reply = 'silent';

    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
    assert.equal(spawned.ok, false);
    if (spawned.ok) return;
    assert.equal(spawned.error.code, 'SkillsConfirmationFailed',
      'the fast-fail swallowed a real skills-drift verdict');
    assert.equal(spawned.error.message.includes('no confirmation arrived'), true);

    const kinds = rig.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.skills-gate.failed'), true);
    assert.equal(kinds.includes('agent.run.provider-turn.never-started'), false);
  } finally {
    rig.close();
  }
});

test('a healthy governed spawn is untouched by the fast-fail', async () => {
  const rig = createRunsRig({ gateTimeoutMs: GATE_TIMEOUT_MS });
  try {
    const role = rig.agents.defineRole('governed');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    assert.equal(spawned.value.run.lifecycle, 'ready');
    assert.equal(rig.terminal.submitted.length, 2, 'the question, then the work it held');
    assert.equal(
      rig.events.some((event) => event.kind === 'agent.run.provider-turn.never-started'),
      false,
    );
  } finally {
    rig.close();
  }
});

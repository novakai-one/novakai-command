// The gate waits for the completion it just caused (NVK-KIMI-080, task 2).
//
// Live evidence: a supervised spawn's skills gate CONFIRMED — the provider
// received turn 1 and answered it with a valid confirmation line — and the
// spawn then refused `RecoveryRequired`, retryable, stage
// `skills-gate-confirmed`, "the confirmed gate turn is not durably completed".
//
// Nothing was wrong. Durable completion is settled by the reconciler on its own
// ~1 s cadence, and measured landing was 1–15 s after confirmation; the gate
// asked once, on the tick the confirmation arrived, and refused the answer
// "not yet". So a spawn that had already done the hard part — reaching a real
// provider and getting the exact canonical token set back — was thrown away and
// handed to an operator to retry, over a race with a clock.
//
// The gate now AWAITS that completion within a bounded budget. The control
// below is the load-bearing half: a completion that never settles must still
// refuse, and still refuse inside the budget, or this has replaced a race with
// a hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRoleProfileId } from '@novakai/foundation/contract';
import { b3ok } from '@novakai/foundation/contract';
import type { ProviderTurnCompletionCoordinator } from '../../core/runs-context.js';
import { createRunsRig } from '../runs-harness.js';

const GATE_TIMEOUT_MS = 8_000;

const spawnInput = (roleProfileId: AgentRoleProfileId) => ({
  roleProfileId,
  displayName: 'Governed',
  workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'Reply OK.' },
});

/** Reports "the evidence has not arrived" for the first `stalls` asks. */
function settlesAfter(stalls: number): (
  inner: ProviderTurnCompletionCoordinator,
) => ProviderTurnCompletionCoordinator {
  let asked = 0;
  return (inner) => async (input) => {
    asked += 1;
    return asked <= stalls
      ? b3ok({ kind: 'evidence-not-yet-available', missing: ['transcript'], retryable: true })
      : inner(input);
  };
}

/** Never settles: the reconciler that would have committed it is not running. */
const neverSettles = (): ProviderTurnCompletionCoordinator => async () =>
  b3ok({ kind: 'evidence-not-yet-available', missing: ['transcript', 'agents'], retryable: true });

test('a gate confirmed one tick before its durable completion still passes', async () => {
  const rig = createRunsRig({
    gateTimeoutMs: GATE_TIMEOUT_MS,
    // Three asks of "not yet" at the gate's own poll cadence — well inside the
    // 1–15 s the live reconciler was measured taking.
    delayCompletionCoordinator: settlesAfter(3),
  });
  try {
    const role = rig.agents.defineRole('governed');
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));

    assert.equal(spawned.ok, true, spawned.ok
      ? ''
      : `a confirmed gate was thrown away over a completion race: ${
        spawned.error.code} — ${spawned.error.message}`);
    if (!spawned.ok) return;
    assert.equal(spawned.value.run.lifecycle, 'ready');

    const kinds = rig.events.map((event) => event.kind);
    assert.equal(kinds.includes('agent.run.skills-gate.passed'), true,
      'the gate never announced the pass it had earned');
    assert.equal(kinds.includes('agent.run.skills-gate.failed'), false,
      'a completion race was recorded as skills drift');
    assert.equal(rig.terminal.submitted.length, 2,
      'the work turn the confirmation released never went out');
  } finally {
    rig.close();
  }
});

test('a gate completion that never settles still refuses, inside its budget', async () => {
  const budgetMs = 1_500;
  const rig = createRunsRig({
    gateTimeoutMs: GATE_TIMEOUT_MS,
    gateCompletionBudgetMs: budgetMs,
    providerTurnCompletionCoordinator: neverSettles(),
  });
  try {
    const role = rig.agents.defineRole('governed');
    const startedAt = Date.now();
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(spawned.ok, false, 'an unsettled completion was treated as settled');
    if (spawned.ok) return;
    assert.equal(spawned.error.code, 'RecoveryRequired');
    assert.equal(spawned.error.details['stage'], 'skills-gate-confirmed');
    assert.equal(spawned.error.details['reason'], 'evidence-not-yet-available',
      'the refusal stopped naming which completion outcome it gave up on');
    assert.equal(spawned.error.retryable, true);
    // The waiting is bounded. `gateTimeoutMs` is the outer bound this must not
    // grow into: a budget that ran to the gate deadline would be a hang.
    assert.ok(elapsedMs < GATE_TIMEOUT_MS,
      `an unsettled completion waited ${String(elapsedMs)}ms, past its ${
        String(budgetMs)}ms budget and into the ${String(GATE_TIMEOUT_MS)}ms gate deadline`);

    assert.equal(
      rig.events.some((event) => event.kind === 'agent.run.skills-gate.passed'), false,
      'the gate announced a pass it never durably completed');
  } finally {
    rig.close();
  }
});

test('a gate whose completion is already durable does not wait at all', async () => {
  const rig = createRunsRig({ gateTimeoutMs: GATE_TIMEOUT_MS });
  try {
    const role = rig.agents.defineRole('governed');
    const startedAt = Date.now();
    const spawned = await rig.runtime.spawnAgent(rig.human(), spawnInput(role));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;
    assert.ok(elapsedMs < 2_000,
      `a healthy spawn spent ${String(elapsedMs)}ms — the wait is firing when nothing is racing`);
    assert.equal(rig.terminal.submitted.length, 2);
  } finally {
    rig.close();
  }
});

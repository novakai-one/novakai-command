// Interrupt-target race (§13.3, DEC-B3V4-29) — a named B3a exit proof.
//
// The danger: an interrupt aimed at a turn that already finished silently
// steals the lease from whoever is typing now. The barrier exists so the
// answer is always one of three honest outcomes, never a quiet side effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintProviderTurnId, mintRuntimeEpochId,
  type ActivityGeneration, type ProviderTurnId,
} from '@novakai/foundation/contract';
import { CONTROL_C } from '../../core/input.js';
import {
  createRig, expectError, humanContext, humanPrincipal, openMockManagedSession,
  runtimeContext, someAgentRunId, unwrap, type Rig,
} from '../harness.js';

const GENERATION = 7 as ActivityGeneration;

async function managedSessionWithTurn(rig: Rig, turnId: ProviderTurnId) {
  const session = unwrap(await openMockManagedSession(rig), 'open');
  const controller = unwrap(await rig.terminal.attachController(humanContext(), {
    terminalSessionId: session.id, controllerKind: 'novakai-shell', columns: 100, rows: 30,
  }), 'attach');
  const lease = unwrap(await rig.terminal.acquireInputLease(humanContext(), {
    terminalSessionId: session.id, attachmentId: controller.id,
    mode: 'acquire-if-free', ttlMs: 60_000,
  }), 'acquire');
  unwrap(await rig.terminal.system.beginProviderTurn(runtimeContext(rig.epochId), {
    terminalSessionId: session.id, agentRunId: someAgentRunId,
    providerTurnId: turnId, activityGeneration: GENERATION,
  }), 'begin turn');
  return { session, controller, lease };
}

test('interrupting the active turn commits the barrier and moves the lease generation', async () => {
  const rig = createRig();
  try {
    const turnId = mintProviderTurnId();
    const { session, lease } = await managedSessionWithTurn(rig, turnId);

    const outcome = unwrap(await rig.terminal.interruptTerminalTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, agentRunId: someAgentRunId,
      providerTurnId: turnId, activityGeneration: GENERATION,
      expectedRuntimeEpochId: rig.epochId,
    }), 'interrupt');

    assert.equal(outcome.kind, 'barrier-committed');
    if (outcome.kind !== 'barrier-committed') return;
    assert.equal(outcome.revokedLeaseGeneration, lease.generation);
    assert.ok(outcome.newLeaseGeneration > lease.generation);
    assert.deepEqual(rig.ptyHost.latest().written, [CONTROL_C]);

    // Input after the barrier is rejected; the session itself is untouched.
    const late = await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: lease.attachmentId,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'after\r',
    });
    assert.equal(expectError(late, 'post-barrier write').code, 'InputLeaseGenerationChanged');
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.session.status, 'live', 'an interrupt stopped the session');
  } finally {
    await rig.dispose();
  }
});

test('a turn that already finished is target-turn-not-active: NOTHING changes', async () => {
  const rig = createRig();
  try {
    const turnId = mintProviderTurnId();
    const { session, lease } = await managedSessionWithTurn(rig, turnId);
    unwrap(await rig.terminal.system.endProviderTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, providerTurnId: turnId,
    }), 'end turn');

    const outcome = unwrap(await rig.terminal.interruptTerminalTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, agentRunId: someAgentRunId,
      providerTurnId: turnId, activityGeneration: GENERATION,
      expectedRuntimeEpochId: rig.epochId,
    }), 'interrupt');

    assert.equal(outcome.kind, 'target-turn-not-active');
    assert.deepEqual(rig.ptyHost.latest().written, [], 'a dead turn still reached the process');

    // The lease the human is holding RIGHT NOW is untouched, and still works.
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.activeInputLease?.id, lease.id);
    assert.equal(view.activeInputLease?.generation, lease.generation);
    unwrap(await rig.terminal.writeInput(humanContext(), {
      terminalSessionId: session.id, attachmentId: lease.attachmentId,
      inputLeaseId: lease.id, leaseGeneration: lease.generation,
      expectedNextInputSequence: 1, kindOfInput: 'text', utf8Text: 'still typing\r',
    }), 'write after no-op interrupt');
  } finally {
    await rig.dispose();
  }
});

test('a stale activity generation cannot interrupt the current turn', async () => {
  const rig = createRig();
  try {
    const turnId = mintProviderTurnId();
    const { session } = await managedSessionWithTurn(rig, turnId);

    const outcome = unwrap(await rig.terminal.interruptTerminalTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, agentRunId: someAgentRunId,
      providerTurnId: turnId, activityGeneration: (GENERATION - 1) as ActivityGeneration,
      expectedRuntimeEpochId: rig.epochId,
    }), 'interrupt with stale generation');
    assert.equal(outcome.kind, 'target-turn-not-active');
    assert.deepEqual(rig.ptyHost.latest().written, []);
  } finally {
    await rig.dispose();
  }
});

test('a turn completing DURING the barrier reports raced-with-completion, revocation stands', async () => {
  const rig = createRig();
  try {
    const turnId = mintProviderTurnId();
    const { session } = await managedSessionWithTurn(rig, turnId);

    // End the turn while the barrier commit is mid-flight — the clock is read
    // during lease settling, which is after the target check and before the
    // re-check. The barrier has already won the ordering race, so the lease
    // change is real either way; the caller is told which actually happened.
    rig.clock.onNextRead(() => {
      void rig.terminal.system.endProviderTurn(runtimeContext(rig.epochId), {
        terminalSessionId: session.id, providerTurnId: turnId,
      });
    });

    const outcome = unwrap(await rig.terminal.interruptTerminalTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, agentRunId: someAgentRunId,
      providerTurnId: turnId, activityGeneration: GENERATION,
      expectedRuntimeEpochId: rig.epochId,
    }), 'interrupt');
    assert.equal(outcome.kind, 'raced-with-completion');
    if (outcome.kind !== 'raced-with-completion') return;
    assert.equal(outcome.inputLeaseChanged, true);
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.activeInputLease, undefined, 'the barrier revocation was rolled back');
  } finally {
    await rig.dispose();
  }
});

test('a stale runtime epoch cannot interrupt anything', async () => {
  const rig = createRig();
  try {
    const turnId = mintProviderTurnId();
    const { session, lease } = await managedSessionWithTurn(rig, turnId);

    const stale = await rig.terminal.interruptTerminalTurn(runtimeContext(rig.epochId), {
      terminalSessionId: session.id, agentRunId: someAgentRunId,
      providerTurnId: turnId, activityGeneration: GENERATION,
      expectedRuntimeEpochId: mintRuntimeEpochId(),
    });
    assert.equal(expectError(stale, 'stale-epoch interrupt').code, 'StaleRuntimeEpoch');
    assert.deepEqual(rig.ptyHost.latest().written, []);
    const view = unwrap(await rig.terminal.getTerminalSession(humanPrincipal(), session.id), 'view');
    assert.equal(view.activeInputLease?.generation, lease.generation);
  } finally {
    await rig.dispose();
  }
});

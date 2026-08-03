// The lifecycle-interrupt barrier (§13.3, DEC-B3V4-29).
//
// The ordering rule exists so an interrupt can never (a) steal the lease from a
// controller whose target turn was already finished, or (b) leave earlier
// keystrokes half-applied. Terminal commits the barrier ONLY while the named
// turn is still active, and only then does the lease generation move.
import {
  b3ok, mintClientOpId, type B3Result, type LeaseGeneration, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { InterruptTerminalTurnInput, InterruptTerminalTurnOutcome } from '../contract/api.js';
import type { ProviderTurnTerminalInputAttempt } from '../contract/records.js';
import { endLease, leasesOf, nextGeneration, settleAndFindActive } from './leases.js';
import { CONTROL_C } from './input.js';
import { clockIso, requireLiveSession, type TerminalCore } from './context.js';
import { listProviderTurnAttempts } from './provider-turn-input.js';

export async function interruptTerminalTurn(
  core: TerminalCore,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: InterruptTerminalTurnInput,
): Promise<B3Result<InterruptTerminalTurnOutcome>> {
  void context;
  const epoch = core.epochFence.assertActive(input.expectedRuntimeEpochId);
  if (!epoch.ok) return epoch;
  const session = await requireLiveSession(core, input.terminalSessionId);
  if (!session.ok) return session;
  const live = core.live.lookup(input.terminalSessionId);
  const attempts = await listProviderTurnAttempts(core, { terminalSessionId: input.terminalSessionId });
  if (!attempts.ok) return attempts;
  const semanticAttempt = attempts.value.find((attempt) =>
    attempt.agentRunId === input.agentRunId
    && attempt.providerTurnId === input.providerTurnId
    && attempt.activityGeneration === input.activityGeneration);
  const semanticActive = semanticAttempt !== undefined
    && (semanticAttempt.turnBarrier.kind === 'active'
      || semanticAttempt.turnBarrier.kind === 'interrupt-committed');
  const legacyActive = semanticAttempt === undefined
    && live?.targets(input.providerTurnId, input.activityGeneration) === true;

  // Steps 4–5: the tuple is not the active turn → change NOTHING. The lease,
  // the controller's draft and any queued writes are untouched.
  if (!live || (!semanticActive && !legacyActive)) {
    return b3ok({ kind: 'target-turn-not-active', inputLeaseChanged: false });
  }
  if (semanticAttempt?.turnBarrier.kind === 'interrupt-committed') {
    return b3ok({
      kind: 'barrier-committed',
      providerTurnId: input.providerTurnId,
      ...(semanticAttempt.turnBarrier.revokedLeaseGeneration === undefined
        ? {}
        : { revokedLeaseGeneration: semanticAttempt.turnBarrier.revokedLeaseGeneration }),
      newLeaseGeneration: semanticAttempt.turnBarrier.newLeaseGeneration,
    });
  }

  // Steps 6–8: the barrier wins the ordering race. From here the lease
  // generation has moved, whatever the provider does next. Input accepted
  // before this point is already durably settled; input after it is rejected
  // with InputLeaseGenerationChanged.
  const active = await settleAndFindActive(core, input.terminalSessionId);
  if (!active.ok) return active;
  let revokedGeneration: LeaseGeneration | undefined;
  if (active.value !== null) {
    const revoked = await endLease(core, active.value, 'revoked', 'runtime-interrupt');
    if (!revoked.ok) return revoked;
    revokedGeneration = active.value.generation;
  }
  const remaining = await leasesOf(core, input.terminalSessionId);
  if (!remaining.ok) return remaining;
  const newLeaseGeneration = nextGeneration(remaining.value);

  if (semanticAttempt !== undefined) {
    const barrier = await core.store.update<ProviderTurnTerminalInputAttempt>(
      'sys_terminal', 'terminalInputAttempt', semanticAttempt.id,
      {
        turnBarrier: {
          kind: 'interrupt-committed',
          barrierCommittedAt: clockIso(core),
          ...(revokedGeneration === undefined
            ? {}
            : { revokedLeaseGeneration: revokedGeneration }),
          newLeaseGeneration,
        },
      },
      semanticAttempt.recordVersion,
      mintClientOpId(),
    );
    if (!barrier.ok) {
      if (barrier.error.code === 'VersionConflict') {
        return b3ok({
          kind: 'raced-with-completion',
          providerTurnId: input.providerTurnId,
          inputLeaseChanged: true,
        });
      }
      return barrier;
    }
  }

  // Step 10: the target turn may have finished DURING the barrier commit above.
  // The revocation stands either way — the barrier won the ordering race — but
  // the caller is told which of the two actually happened.
  const completedDuringBarrier = semanticAttempt === undefined
    && !live.targets(input.providerTurnId, input.activityGeneration);

  // Step 9: only now is the provider actually interrupted.
  live.pty.write(CONTROL_C);
  live.activeTurn = null;

  if (completedDuringBarrier) {
    return b3ok({
      kind: 'raced-with-completion',
      providerTurnId: input.providerTurnId,
      inputLeaseChanged: true,
    });
  }
  return b3ok({
    kind: 'barrier-committed',
    providerTurnId: input.providerTurnId,
    ...(revokedGeneration === undefined ? {} : { revokedLeaseGeneration: revokedGeneration }),
    newLeaseGeneration,
  } as InterruptTerminalTurnOutcome);
}

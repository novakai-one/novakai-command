// LANE B — the exact §9.2 activity-drift reducer.
//
// Free evidence is read through one host port. The reducer owns fingerprinting
// so adapters cannot accidentally count record ids, timestamps, or audit refs
// as movement. It owns no provider/Terminal command and therefore cannot start
// a turn while deciding whether evidence moved.
import {
  b3fail,
  b3ok,
  type B3Result,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  type CheckRunDriftInput,
  type DriftCheckOutcome,
  type DriftEvidenceCheckpoint,
} from '../../contract/index.js';
import { recordMovement } from './drift-movement.js';
import { advanceUnchangedEvidence } from './drift-quiet.js';
import {
  evidenceCheckpoint,
  loadCurrentDrift,
  watcherConflict,
  type CurrentDrift,
  type DriftDependencies,
  type DriftEvidenceObservation,
} from './drift-support.js';

export {
  driftEvidenceFingerprint,
  type DriftEvidenceObservation,
  type DriftEvidencePort,
} from './drift-support.js';

type DriftContext = SystemCommandContext<'sys_supervision'>;

interface CheckedEvidence {
  readonly observedAt: Date;
  readonly observation: DriftEvidenceObservation;
  readonly checkpoint: DriftEvidenceCheckpoint;
}

async function checkEvidence(
  deps: DriftDependencies,
  current: CurrentDrift,
  input: CheckRunDriftInput,
): Promise<B3Result<CheckedEvidence>> {
  const observedAt = deps.clock();
  if (observedAt.getTime() < Date.parse(current.deadline.dueAt)) {
    return b3fail(watcherConflict('the drift deadline is not due', {
      watchDeadlineId: current.deadline.id,
      dueAt: current.deadline.dueAt,
      checkedAt: observedAt.toISOString(),
    }));
  }
  const observed = await deps.evidence.observe(input.agentRunId);
  if (!observed.ok) return b3fail(observed.error);
  if (observed.value.terminalActivityGeneration !== input.expectedActivityGeneration) {
    return b3fail(watcherConflict('free evidence belongs to another activity generation', {
      expectedActivityGeneration: input.expectedActivityGeneration,
      observedActivityGeneration: observed.value.terminalActivityGeneration,
    }));
  }
  return b3ok({
    observedAt,
    observation: observed.value,
    checkpoint: evidenceCheckpoint(observed.value, observedAt.toISOString() as IsoUtc),
  });
}

/** §9.2 steps 1–3: fingerprint, movement reset, and first quiet interval. */
export async function checkRunDrift(
  deps: DriftDependencies,
  _context: DriftContext,
  input: CheckRunDriftInput,
): Promise<B3Result<DriftCheckOutcome>> {
  const current = await loadCurrentDrift(deps, input);
  if (!current.ok) return b3fail(current.error);
  const evidence = await checkEvidence(deps, current.value, input);
  if (!evidence.ok) return b3fail(evidence.error);
  const { observedAt, observation, checkpoint: nextEvidence } = evidence.value;
  const priorState = current.value.deadline.driftState!;
  const moved = priorState.lastEvidence === undefined
    || priorState.lastEvidence.fingerprint !== nextEvidence.fingerprint;
  if (moved) {
    return recordMovement(deps, current.value, observation, nextEvidence, observedAt);
  }
  return advanceUnchangedEvidence(
    deps, current.value, observation, nextEvidence, observedAt,
  );
}

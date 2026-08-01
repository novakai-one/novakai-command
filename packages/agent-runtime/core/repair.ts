// The published recovery action (§12.2 `repairRunOperation`, §20).
//
// §20 names exactly one recovery for a partially failed stop-tree — "resume
// same operation" — and exactly one forbidden action: "unfreeze/restart subtree
// silently". So repair resumes the stop under the fence that is still closed,
// and settles only when every Agent in the snapshot is actually final.
//
// For an operation an earlier epoch abandoned, repair does the paperwork boot
// recovery deliberately left open: it confirms the Run this attempt reserved is
// final, releases the fence it was holding, and closes the journal — unless
// compensation recorded UNCERTAINTY, in which case it says so and leaves the
// record open. An operation nobody can close is how a store fills with work
// that looks live forever (hold-out G6); an operation closed over an effect
// nobody verified is worse.
import {
  b3err, b3fail, b3ok, mintClientOpId,
  type B3Result, type CommandContext, type RunOperationId,
} from '@novakai/foundation/contract';
import type { RunOperationView } from '../contract/runs-api.js';
import type { RunOperation, RunOperationKind } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import { compensate, settleOperation, unresolvedUncertainty } from './journal.js';
import { getRunOperation } from './queries.js';
import {
  descendantsOf, fenceOfOperation, settleTreeStop, stopEachBottomUp,
} from './stop-tree.js';

/** Which authority a caller needs to repair each kind of operation. */
const AUTHORITY: Readonly<Record<RunOperationKind, Parameters<
  RunsCore['agents']['authoriseRunOperation']
>[1]['operation']>> = {
  spawn: 'continue',
  continue: 'continue',
  'stop-one': 'stop-one',
  'stop-tree': 'stop-tree',
  adopt: 'adopt',
};

export async function repairRunOperation(
  core: RunsCore, context: CommandContext, operationId: RunOperationId,
): Promise<B3Result<RunOperationView>> {
  const found = await core.store.read<RunOperation>('runOperation', operationId);
  if (!found.ok) return found;
  const operation = found.value;
  if (operation === null) {
    return b3fail(b3err('RecoveryRequired', 'no such operation',
      { operationId, stage: 'unknown', reason: 'no such operation' }, false));
  }
  const allowed = await authorise(core, context, operation);
  if (!allowed.ok) return allowed;

  if (operation.state === 'completed') return getRunOperation(core, context.principal, operationId);
  if (isInFlight(core, operation)) {
    return b3fail(b3err('RecoveryRequired',
      'that operation is still running in this epoch; nothing to repair yet',
      { operationId, stage: operation.currentStage, reason: 'operation-still-in-flight' }, true));
  }
  if (operation.kindOfOperation === 'stop-tree' && operation.state === 'tree-stop-pending') {
    const resumed = await resumeTreeStop(core, context, operation);
    if (!resumed.ok) return resumed;
    return getRunOperation(core, context.principal, operationId);
  }
  const closed = await closeAbandoned(core, operation);
  if (!closed.ok) return closed;
  return getRunOperation(core, context.principal, operationId);
}

async function authorise(
  core: RunsCore, context: CommandContext, operation: RunOperation,
): Promise<B3Result<null>> {
  const targetAgentId = operation.agentId;
  if (targetAgentId === undefined) return b3ok(null);
  const allowed = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId, operation: AUTHORITY[operation.kindOfOperation],
  });
  return allowed.ok ? b3ok(null) : b3fail(allowed.error);
}

/** A live attempt in the CURRENT epoch is not stranded — it is working. */
function isInFlight(core: RunsCore, operation: RunOperation): boolean {
  if (operation.state !== 'running' && operation.state !== 'continuation-pending') return false;
  return core.fence.activeEpochId() === operation.runtimeEpochId;
}

/**
 * Stop what is left of the snapshot, under the fence that never opened.
 *
 * The Agents already recorded `succeeded` are not touched again: their outcome
 * is durable evidence, and re-terminating a stopped Run would turn a resumed
 * recovery into a second stop.
 */
async function resumeTreeStop(
  core: RunsCore, context: CommandContext, operation: RunOperation,
): Promise<B3Result<RunOperation>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  const previous = operation.perAgentOutcomes ?? [];
  const done = new Set(previous.filter((item) => item.outcome === 'succeeded')
    .map((item) => item.agentId));

  const rootAgentId = operation.agentId;
  if (rootAgentId === undefined) {
    return b3fail(b3err('RecoveryRequired', 'a stop-tree operation without a root cannot resume',
      { operationId: operation.id, stage: operation.currentStage, reason: 'no-root-agent' }, false));
  }
  const remaining = await descendantsOf(core, context, rootAgentId);
  if (!remaining.ok) return remaining;
  const order = [...remaining.value].reverse().concat(rootAgentId)
    .filter((agentId) => !done.has(agentId));

  const retried = await stopEachBottomUp(core, context, order, epoch.value);
  if (!retried.ok) return retried;
  const fence = await fenceOfOperation(core, operation);
  if (!fence.ok) return fence;
  return settleTreeStop(core, operation, fence.value, [
    ...previous.filter((item) => done.has(item.agentId)),
    ...retried.value,
  ]);
}

/**
 * An operation an earlier epoch left behind. Compensation re-reads the journal
 * and settles whatever this attempt reserved; the fence it held is released,
 * because a fence outliving its operation freezes a family nobody is stopping.
 */
async function closeAbandoned(
  core: RunsCore, operation: RunOperation,
): Promise<B3Result<RunOperation>> {
  const epochId = core.fence.activeEpochId();
  if (epochId === null) {
    return b3fail(b3err('RuntimeUnavailable', 'no runtime epoch is active',
      { reason: 'no-active-epoch' }, true));
  }
  const compensated = await compensate(core, operation, epochId, 'repair-requested');
  if (!compensated.ok) return compensated;
  const fence = await fenceOfOperation(core, compensated.value);
  if (!fence.ok) return fence;
  if (fence.value !== null) {
    const released = await core.store.update(
      'sys_agent_runtime', fence.value.id, { state: 'released' },
      fence.value.recordVersion, mintClientOpId(),
    );
    if (!released.ok) return released;
  }
  const uncertain = unresolvedUncertainty(compensated.value);
  if (uncertain.length > 0) {
    return b3fail(b3err('RecoveryRequired',
      'repair could not confirm every effect; the operation stays open',
      {
        operationId: operation.id,
        stage: compensated.value.currentStage,
        reason: uncertain.map((item) => item.effectKey).join('; '),
      }, false));
  }
  return settleOperation(core, compensated.value, 'completed');
}

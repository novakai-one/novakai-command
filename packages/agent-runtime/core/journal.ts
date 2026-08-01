// The recoverable operation journal (DEC-B3V4-26, §6.3, §13.5).
//
// The rule this file exists for: NO Agent, Run, PTY, provider, Messaging or
// Transcript effect happens before the first RunOperation record is durable. A
// crash before that append therefore leaves nothing behind, and a crash after
// it leaves a record that names exactly which effects already happened and what
// their keys were.
//
// Recovery never repeats an effect. It queries the effect by its stable key
// first, and if the answer is "I cannot tell", it says `recovery-required`
// rather than trying again — because trying again is how one Run becomes two.
import {
  b3ok, commandReceiptId, mintClientOpId, mintProviderSessionId, mintRunOperationId,
  nowIsoUtc,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type CommandReceiptId, type ProviderSessionId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type {
  RunOperation, RunOperationKind, RunOperationStage, RunOperationStageOutcome,
} from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import type { Persisted } from './runs-store.js';

/**
 * A stage's effect key. Stable across every retry of the same command, so
 * recovery can ask an owner "did YOU already do this?" instead of guessing from
 * timestamps (§3.2's "every external saga effect derives its idempotency key
 * from the receipt plus stage name").
 */
export function effectKeyFor(operationId: string, stage: RunOperationStage): string {
  return `${operationId}:${stage}`;
}

export interface OpenedOperation {
  readonly operation: RunOperation;
  /** True when this call created it; false when it resumed an earlier attempt. */
  readonly fresh: boolean;
}

/**
 * Open — or re-open — the journal for one command.
 *
 * The id is derived from the command receipt, so the same `clientOpId` finds
 * the same journal after a crash. `reservedProviderSessionId` is minted HERE,
 * before the first append, and never changes: §20's "resume same operation and
 * same reservation" is only possible if the reservation predates every effect.
 */
export async function openOperation(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly kindOfOperation: RunOperationKind;
    readonly runtimeEpochId: RuntimeEpochId;
    readonly agentId?: AgentId;
    readonly oldRunId?: AgentRunId;
    readonly reserveProviderSession: boolean;
  },
): Promise<B3Result<OpenedOperation>> {
  const receiptId = commandReceiptId(
    context.principal.id, operationNameOf(input.kindOfOperation), context.clientOpId,
  );
  const operationId = mintRunOperationId(receiptId);
  const existing = await core.store.read<RunOperation>('runOperation', operationId);
  if (!existing.ok) return existing;
  if (existing.value !== null) return b3ok({ operation: existing.value, fresh: false });

  const record: Persisted<RunOperation> = {
    kind: 'runOperation',
    id: operationId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    kindOfOperation: input.kindOfOperation,
    commandReceiptId: receiptId as CommandReceiptId,
    runtimeEpochId: input.runtimeEpochId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.oldRunId === undefined ? {} : { oldRunId: input.oldRunId }),
    ...(input.reserveProviderSession
      ? { reservedProviderSessionId: mintProviderSessionId() } : {}),
    currentStage: 'receipt-accepted',
    completedStages: [],
    compensation: [],
    state: 'running',
  };
  const created = await core.store.create<RunOperation>(
    context.principal.id, record as never, mintClientOpId(),
  );
  if (!created.ok) return created;
  return b3ok({ operation: created.value, fresh: true });
}

export interface StageAdvance {
  readonly stage: RunOperationStage;
  readonly owner: string;
  readonly ownerObjectId?: string;
  /** `not-needed` records a stage whose owning capability arrives in a later slice. */
  readonly outcome?: 'completed' | 'not-needed';
  readonly deferredTo?: string;
}

/**
 * Advance one stage, under CAS, after its owner confirmed a durable outcome.
 *
 * Re-advancing a stage already recorded is a no-op that returns the same
 * operation: a retry that got further last time must not rewind the ladder.
 */
export async function advance(
  core: RunsCore,
  operation: RunOperation,
  step: StageAdvance,
  patch: Partial<Persisted<RunOperation>> = {},
): Promise<B3Result<RunOperation>> {
  if (operation.completedStages.some((done) => done.stage === step.stage)) {
    return b3ok(operation);
  }
  const outcome: RunOperationStageOutcome = {
    stage: step.stage,
    effectKey: effectKeyFor(operation.id, step.stage),
    owner: step.owner,
    ...(step.ownerObjectId === undefined ? {} : { ownerObjectId: step.ownerObjectId }),
    completedAt: nowIsoUtc(),
    ...(step.outcome === undefined ? {} : { outcome: step.outcome }),
    ...(step.deferredTo === undefined ? {} : { deferredTo: step.deferredTo }),
  };
  const written = await core.store.update<RunOperation>(
    'sys_agent_runtime', operation.id,
    {
      ...patch,
      currentStage: step.stage,
      completedStages: [...operation.completedStages, outcome],
    } as Record<string, unknown>,
    operation.recordVersion, mintClientOpId(),
  );
  if (written.ok) {
    core.publish('agent.run.operation.stage.changed', {
      operationId: operation.id, stage: step.stage, effectKey: outcome.effectKey,
    });
  }
  return written;
}

/** Whether an earlier attempt already got past a stage. */
export function completed(
  operation: RunOperation, stage: RunOperationStage,
): RunOperationStageOutcome | null {
  return operation.completedStages.find((done) => done.stage === stage) ?? null;
}

export async function settleOperation(
  core: RunsCore,
  operation: RunOperation,
  state: RunOperation['state'],
  patch: Partial<Persisted<RunOperation>> = {},
): Promise<B3Result<RunOperation>> {
  return core.store.update<RunOperation>(
    'sys_agent_runtime', operation.id,
    { ...patch, state, currentStage: stageForState(state) } as Record<string, unknown>,
    operation.recordVersion, mintClientOpId(),
  );
}

function stageForState(state: RunOperation['state']): RunOperationStage {
  if (state === 'completed') return 'completed';
  if (state === 'recovery-required') return 'recovery-required';
  return 'compensating';
}

/**
 * Undo what CAN be undone, and say plainly what could not.
 *
 * §13.5: "an uncertain provider/PTY effect is reconciled, not blindly repeated
 * or killed". A terminal this operation itself started is ours to stop; a
 * provider session we merely reserved never became anything to compensate.
 */
export async function compensate(
  core: RunsCore,
  operation: RunOperation,
  epochId: RuntimeEpochId,
  reason: string,
): Promise<B3Result<RunOperation>> {
  const outcomes: RunOperation['compensation'][number][] = [];
  const terminal = completed(operation, 'terminal-live') ?? completed(operation, 'terminal-reserved');
  if (terminal?.ownerObjectId !== undefined && operation.newRunId !== undefined) {
    const stopped = await core.terminal.terminate({
      terminalSessionId: terminal.ownerObjectId as never,
      agentRunId: operation.newRunId,
      expectedRuntimeEpochId: epochId,
      reason: 'spawn-compensation',
    });
    outcomes.push({
      stage: terminal.stage,
      effectKey: terminal.effectKey,
      outcome: stopped.ok ? 'succeeded' : 'uncertain',
      ...(stopped.ok ? {} : { reason: stopped.error.message }),
    });
  }
  const settled = await settleOperation(core, operation, 'recovery-required', {
    compensation: [...operation.compensation, ...outcomes],
  });
  if (!settled.ok) return settled;
  core.publish('runtime.recovery.required', { operationId: operation.id, reason });
  return settled;
}

const OPERATION_NAMES: Readonly<Record<RunOperationKind, string>> = {
  spawn: 'agent.spawn',
  continue: 'agent.continue',
  'stop-one': 'agent.stop',
  'stop-tree': 'agent.stopTree',
  adopt: 'agent.adopt',
};

export function operationNameOf(kind: RunOperationKind): string {
  return OPERATION_NAMES[kind];
}

export const reservationOf = (operation: RunOperation): ProviderSessionId =>
  operation.reservedProviderSessionId ?? mintProviderSessionId();

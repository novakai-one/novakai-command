// Stopping a whole subtree (§13.7, DEC-B3V4-11).
//
// Kept apart from `lifecycle.ts` because it is a different KIND of operation: a
// separate scope, a separate confirmation, a fence, and a per-Agent result set
// that survives a partial failure. Stop-one is a decision about one Run;
// stop-tree is a decision about a team.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTreeMutationFenceId, nowIsoUtc,
  type AgentId, type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import { createHash } from 'node:crypto';
import type { StopAgentTreeInput, StopTreeConfirmation } from '../contract/runs-api.js';
import type { RunOperation, TreeMutationFence } from '../contract/runs.js';
import { liveRunOf, type RunsCore } from './runs-context.js';
import type { Persisted } from './runs-store.js';
import { openOperation, settleOperation } from './journal.js';
import { closeRun } from './lifecycle.js';



/**
 * The confirmation token signs the tree the caller was SHOWN. A subtree that
 * grew between preparing and confirming produces a different token, so the
 * caller is stopping what they looked at rather than what happened to be there.
 */
export async function prepareStopAgentTree(
  core: RunsCore, context: CommandContext, rootAgentId: AgentId,
): Promise<B3Result<StopTreeConfirmation>> {
  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: rootAgentId, operation: 'stop-tree',
  });
  if (!authorised.ok) return authorised;
  const descendants = await descendantsOf(core, context, rootAgentId);
  if (!descendants.ok) return descendants;
  const expiresAt = new Date(core.clock() + STOP_TREE_TOKEN_TTL_MS).toISOString();
  return b3ok({
    rootAgentId,
    visibleDescendantCount: descendants.value.length,
    confirmationToken: stopTreeToken(rootAgentId, descendants.value),
    expiresAt: expiresAt as never,
  });
}

const STOP_TREE_TOKEN_TTL_MS = 5 * 60 * 1000;

export function stopTreeToken(rootAgentId: AgentId, descendants: readonly AgentId[]): string {
  return createHash('sha256')
    .update(`b3v4.stop-tree:${rootAgentId}:${[...descendants].sort().join(',')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * Fence, snapshot until stable, stop bottom-up, record every Agent's result.
 * The fence is released only on complete success — a partial failure stays
 * `tree-stop-pending` so the same operation can be resumed rather than a
 * half-stopped subtree quietly unfreezing (§13.7 step 7).
 */
export async function stopAgentTree(
  core: RunsCore, context: CommandContext, input: StopAgentTreeInput,
): Promise<B3Result<RunOperation>> {
  const epoch = core.fence.assertActive(context.runtimeEpochId);
  if (!epoch.ok) return epoch;
  const authorised = await core.agents.authoriseRunOperation(context.principal, {
    targetAgentId: input.rootAgentId, operation: 'stop-tree',
  });
  if (!authorised.ok) return authorised;

  const opened = await openOperation(core, context, {
    kindOfOperation: 'stop-tree',
    runtimeEpochId: epoch.value,
    agentId: input.rootAgentId,
    reserveProviderSession: false,
  });
  if (!opened.ok) return opened;

  const fenced = await closeFence(core, context, input.rootAgentId, opened.value.operation);
  if (!fenced.ok) return fenced;

  const order = await confirmedOrder(core, context, input, fenced.value);
  if (!order.ok) return order;

  const outcomes = await stopEachBottomUp(core, context, order.value, epoch.value);
  if (!outcomes.ok) return outcomes;

  const everyOneStopped = outcomes.value.every((item) => item.outcome === 'succeeded');
  if (everyOneStopped) await releaseFence(core, fenced.value);
  return settleOperation(
    core, opened.value.operation,
    everyOneStopped ? 'completed' : 'tree-stop-pending',
    { perAgentOutcomes: outcomes.value },
  );
}

/**
 * The exact set the caller was SHOWN, bottom-up. A token that no longer matches
 * means the subtree changed between preparing and confirming, so the fence is
 * released and the caller is asked to look again — stopping something they have
 * not seen is precisely the surprise §13.7 exists to prevent.
 */
async function confirmedOrder(
  core: RunsCore,
  context: CommandContext,
  input: StopAgentTreeInput,
  fence: TreeMutationFence,
): Promise<B3Result<readonly AgentId[]>> {
  const snapshot = await stableSnapshot(core, context, input.rootAgentId);
  if (!snapshot.ok) return snapshot;
  if (stopTreeToken(input.rootAgentId, snapshot.value) !== input.confirmationToken) {
    await releaseFence(core, fence);
    return b3fail(b3err('TreeClosing',
      'the tree changed since it was prepared; prepare it again and re-confirm',
      { rootAgentId: input.rootAgentId, fenceId: fence.id }, true));
  }
  // A child is stopped before the parent that supervises it.
  return b3ok([...snapshot.value].reverse().concat(input.rootAgentId));
}

async function stopEachBottomUp(
  core: RunsCore,
  context: CommandContext,
  order: readonly AgentId[],
  epochId: Parameters<typeof closeRun>[4],
): Promise<B3Result<NonNullable<RunOperation['perAgentOutcomes']>>> {
  const outcomes: NonNullable<RunOperation['perAgentOutcomes']>[number][] = [];
  for (const agentId of order) {
    const live = await liveRunOf(core, agentId);
    if (!live.ok) return live;
    if (live.value === null) {
      outcomes.push({ agentId, outcome: 'succeeded', reason: 'no live run' });
      continue;
    }
    const closed = await closeRun(core, context, live.value, 'explicit-tree-stop', epochId);
    const succeeded = closed.ok && closed.value.lifecycle === 'stopped';
    outcomes.push({
      agentId,
      agentRunId: live.value.id,
      outcome: succeeded ? 'succeeded' : 'uncertain',
      ...(closed.ok ? {} : { reason: closed.error.message }),
    });
  }
  return b3ok(outcomes);
}

async function closeFence(
  core: RunsCore, context: CommandContext, rootAgentId: AgentId, operation: RunOperation,
): Promise<B3Result<TreeMutationFence>> {
  const existing = await core.store.list<TreeMutationFence>('treeMutationFence', {
    rootAgentId, state: 'closing',
  });
  if (!existing.ok) return existing;
  const held = existing.value[0];
  if (held !== undefined) return b3ok(held);

  const record: Persisted<TreeMutationFence> = {
    kind: 'treeMutationFence',
    id: mintTreeMutationFenceId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    rootAgentId,
    operationId: operation.id,
    state: 'closing',
    descendantSnapshotVersion: 1,
  };
  return core.store.create<TreeMutationFence>(
    context.principal.id, record as never, mintClientOpId(),
  );
}

async function releaseFence(
  core: RunsCore, fence: TreeMutationFence,
): Promise<B3Result<TreeMutationFence>> {
  return core.store.update<TreeMutationFence>(
    'sys_agent_runtime', fence.id, { state: 'released' },
    fence.recordVersion, mintClientOpId(),
  );
}

/**
 * §13.7 step 4: "repeatedly snapshot until all pre-fence descendants are
 * included". Two identical reads in a row mean the fence is holding.
 */
async function stableSnapshot(
  core: RunsCore, context: CommandContext, rootAgentId: AgentId,
): Promise<B3Result<readonly AgentId[]>> {
  let previous: readonly AgentId[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const seen = await descendantsOf(core, context, rootAgentId);
    if (!seen.ok) return seen;
    if (attempt > 0 && sameSet(previous, seen.value)) return seen;
    previous = seen.value;
  }
  return b3ok(previous);
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join(',') === [...right].sort().join(',');

/** Breadth-first, so the returned order is safe to reverse for bottom-up. */
export async function descendantsOf(
  core: RunsCore, context: CommandContext, rootAgentId: AgentId,
): Promise<B3Result<readonly AgentId[]>> {
  const found: AgentId[] = [];
  const seen = new Set<AgentId>([rootAgentId]);
  let frontier: readonly AgentId[] = [rootAgentId];
  while (frontier.length > 0) {
    const generation = await unseenChildren(core, context, frontier, seen);
    if (!generation.ok) return generation;
    found.push(...generation.value);
    frontier = generation.value;
  }
  return b3ok(found);
}

/** One generation down, skipping anyone already counted. */
async function unseenChildren(
  core: RunsCore,
  context: CommandContext,
  frontier: readonly AgentId[],
  seen: Set<AgentId>,
): Promise<B3Result<readonly AgentId[]>> {
  const next: AgentId[] = [];
  for (const parent of frontier) {
    const children = await core.agents.listChildAgentIds(context.principal, parent);
    if (!children.ok) return children;
    for (const child of children.value) {
      if (seen.has(child)) continue;
      seen.add(child);
      next.push(child);
    }
  }
  return b3ok(next);
}

/** Whether a closing tree currently forbids mutating this Agent (§13.7 step 3). */
export async function insideClosingTree(
  core: RunsCore, context: CommandContext, agentId: AgentId,
): Promise<B3Result<TreeMutationFence | null>> {
  const fences = await core.store.list<TreeMutationFence>('treeMutationFence', {
    state: 'closing',
  });
  if (!fences.ok) return fences;
  for (const fence of fences.value) {
    const covers = await fenceCovers(core, context, fence, agentId);
    if (!covers.ok) return covers;
    if (covers.value) return b3ok(fence);
  }
  return b3ok(null);
}

async function fenceCovers(
  core: RunsCore, context: CommandContext, fence: TreeMutationFence, agentId: AgentId,
): Promise<B3Result<boolean>> {
  if (fence.rootAgentId === agentId) return b3ok(true);
  const inside = await descendantsOf(core, context, fence.rootAgentId);
  if (!inside.ok) return inside;
  return b3ok(inside.value.includes(agentId));
}

export const treeClosing = (
  rootAgentId: string, fenceId: string,
): ReturnType<typeof b3err> => b3err('TreeClosing',
  'that subtree is being stopped; spawn, continue and adopt are refused under the fence',
  { rootAgentId, fenceId }, true);


// What every Run operation shares.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintSupervisionAssignmentId, nowIsoUtc,
  type AgentId, type AgentRunId, type AuthorityScope, type B3Result,
  type CommandContext, type ReceiptStore, type RecordVersion,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { RuntimeHostContract } from '../contract/types.js';
import type {
  AgentsPort, ProviderPort, RunCredentialPort, TerminalPort,
} from '../contract/ports.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type SupervisionAssignment,
} from '../contract/runs.js';
import type { RunsStore, Persisted } from './runs-store.js';

export interface RunsCore {
  readonly store: RunsStore;
  readonly agents: AgentsPort;
  readonly terminal: TerminalPort;
  readonly providers: ProviderPort;
  readonly credentials: RunCredentialPort;
  readonly receipts: ReceiptStore;
  readonly fence: RuntimeHostContract['fence'];
  /** Emitted after a commit, never before it (§15). */
  readonly publish: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly defaultViewport: { readonly columns: number; readonly rows: number };
  /** How long the gate waits for turn 1's confirmation before failing it. */
  readonly gateTimeoutMs: number;
  readonly clock: () => number;
}

export const OPERATION = {
  spawn: 'agent.spawn',
  interrupt: 'agent.interrupt',
  stopOne: 'agent.stop',
  prepareStopTree: 'agent.prepareStopTree',
  stopTree: 'agent.stopTree',
  continueRun: 'agent.continue',
  adopt: 'agent.adopt',
  control: 'agent.control',
  repair: 'agent.repair',
} as const;

/** The scopes a Run's own grant carries. Intersected upward, never widened. */
export const RUN_SCOPES: readonly AuthorityScope[] = [
  'agent.spawn', 'agent.interrupt', 'agent.stop-one', 'agent.continue', 'agent.control',
] as AuthorityScope[];

/** §3.5: an unknown newer contract version is refused, never guessed at. */
export function versionGuard<T>(context: CommandContext): B3Result<T> | null {
  if (context.contractVersion === 1) return null;
  return b3fail(b3err('UnsupportedContractVersion',
    `contract version ${String(context.contractVersion)} is not supported`,
    { received: context.contractVersion, supported: [1] }, false));
}

export function systemContext(context: CommandContext): SystemCommandContext<'sys_agent_runtime'> {
  return {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: context.clientOpId,
    traceId: context.traceId,
    contractVersion: 1,
  };
}

export async function requireRun(
  core: RunsCore, agentRunId: AgentRunId,
): Promise<B3Result<AgentRun>> {
  const found = await core.store.read<AgentRun>('agentRun', agentRunId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(b3err('UnknownAgentRun', `no agent agentRun "${agentRunId}"`, { agentRunId }, false));
  }
  return b3ok(found.value);
}

/**
 * One Agent has at most one Run that is not final (§6.1). This is the query
 * that keeps it true, and it reads the store rather than any cache: a second
 * process asking the same question must get the same answer.
 */
export async function liveRunOf(
  core: RunsCore, agentId: AgentId,
): Promise<B3Result<AgentRun | null>> {
  const runs = await core.store.list<AgentRun>('agentRun', { agentId });
  if (!runs.ok) return runs;
  const live = runs.value.find((agentRun) => !FINAL_LIFECYCLES.has(agentRun.lifecycle));
  return b3ok(live ?? null);
}

export async function currentAssignment(
  core: RunsCore, subjectAgentId: AgentId,
): Promise<B3Result<SupervisionAssignment | null>> {
  const chain = await assignmentChain(core, subjectAgentId);
  if (!chain.ok) return chain;
  return b3ok(chain.value.current);
}

/**
 * The whole supervision history of one Agent, newest first, and how long it is.
 *
 * The length matters: assignments are APPEND-ONLY records, so every one of them
 * has `recordVersion: 1` and comparing record versions would be a compare-and-set
 * that always agrees. The chain length is the generation counter — adoption N+1
 * must present N, so two adopters who read the same state cannot both win.
 */
export async function assignmentChain(
  core: RunsCore, subjectAgentId: AgentId,
): Promise<B3Result<{
  readonly current: SupervisionAssignment | null;
  readonly generation: RecordVersion;
}>> {
  const listed = await core.store.list<SupervisionAssignment>(
    'supervisionAssignment', { subjectAgentId },
  );
  if (!listed.ok) return listed;
  const sorted = [...listed.value].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt));
  return b3ok({
    current: sorted[0] ?? null,
    generation: sorted.length as RecordVersion,
  });
}

/** Record who supervises an Agent now. Never touches who spawned it. */
export async function assignSupervisor(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly subjectAgentId: AgentId;
    readonly supervisor: SupervisionAssignment['supervisor'];
    readonly reason: SupervisionAssignment['reason'];
    readonly previousAssignmentId?: SupervisionAssignment['id'];
  },
): Promise<B3Result<SupervisionAssignment>> {
  const record: Persisted<SupervisionAssignment> = {
    kind: 'supervisionAssignment',
    id: mintSupervisionAssignmentId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    subjectAgentId: input.subjectAgentId,
    supervisor: input.supervisor,
    reason: input.reason,
    ...(input.previousAssignmentId === undefined
      ? {} : { previousAssignmentId: input.previousAssignmentId }),
  };
  const written = await core.store.create<SupervisionAssignment>(
    context.principal.id, record as never, mintClientOpId(),
  );
  if (written.ok) {
    core.publish('agent.supervision.changed', {
      subjectAgentId: input.subjectAgentId, supervisor: input.supervisor,
    });
  }
  return written;
}

/** Patch a Run under CAS. Every lifecycle move in this package goes through here. */
export async function patchRun(
  core: RunsCore, agentRun: AgentRun, patch: Partial<Persisted<AgentRun>>,
): Promise<B3Result<AgentRun>> {
  const written = await core.store.update<AgentRun>(
    'sys_agent_runtime', agentRun.id, patch as Record<string, unknown>,
    agentRun.recordVersion, mintClientOpId(),
  );
  if (!written.ok) return written;
  if (patch.lifecycle !== undefined && patch.lifecycle !== agentRun.lifecycle) {
    core.publish('agent.run.lifecycle.changed', {
      agentRunId: agentRun.id,
      fromLifecycle: agentRun.lifecycle,
      toLifecycle: patch.lifecycle,
    });
  }
  if (patch.activity !== undefined && patch.activity !== agentRun.activity) {
    core.publish('agent.run.activity.changed', {
      agentRunId: agentRun.id, activity: patch.activity,
    });
  }
  return written;
}

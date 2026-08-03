// What every Run operation shares.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintSupervisionAssignmentId, nowIsoUtc,
  type AgentId, type AgentRunId, type AuthorityScope, type B3Result,
  type CommandContext, type ReceiptStore, type RecordVersion,
  type SystemCommandContext, type TraceCorrelationId,
} from '@novakai/foundation/contract';
import type { RuntimeHostContract } from '../contract/types.js';
import type { RunEvent, RunUsageLookup } from '../contract/runs-api.js';
import type {
  AgentsPort, MessagingEndpointPort, ProviderPort, RunCredentialPort, TerminalPort,
  NotificationDeliveryPort, RunWatcherPort, TranscriptCustodyPort,
} from '../contract/ports.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type SupervisionAssignment,
} from '../contract/runs.js';
import type { RunsStore, Persisted } from './runs-store.js';

/**
 * What Agent Runtime may ask Transcript about a Run (§19.1).
 *
 * A read, through a contract, of a fact Transcript owns — never a store
 * access. Optional because a host with no Transcript wired is a legitimate
 * configuration, and the view says `unbound` rather than inventing a state.
 */
export type TranscriptBindingLookup = (agentRunId: AgentRunId) => Promise<{
  readonly bindingState: 'bound' | 'waiting' | 'missing' | 'corrupt';
  readonly mirrorWatermark?: string;
} | null>;

export interface RunsCore {
  readonly store: RunsStore;
  readonly agents: AgentsPort;
  readonly terminal: TerminalPort;
  readonly providers: ProviderPort;
  readonly credentials: RunCredentialPort;
  readonly receipts: ReceiptStore;
  readonly fence: RuntimeHostContract['fence'];
  /** §19.1's transcript section. Absent means no Transcript is composed. */
  readonly transcriptBinding?: TranscriptBindingLookup;
  /**
   * §13.5 rows 6/10 and §13.6's endpoint cutover.
   *
   * Optional because a host composed without Messaging is a legitimate
   * configuration — the B3a Runtime and every Runs-only test suite is one. What
   * is NOT legitimate is a host that HAS Messaging and skips the stage anyway:
   * the ladder then records `not-needed` naming the absent capability, which is
   * a true statement about that host, and the production composition never
   * takes that branch (see `b3c-production-lifecycle.test.ts`).
   */
  readonly messagingEndpoint?: MessagingEndpointPort;
  /** §13.5 row 9 and §13.6's final watermark. Optional for the same reason. */
  readonly transcriptCustody?: TranscriptCustodyPort;
  /** B3d §13.5's watcher rung. Optional for the same reason as the two above. */
  readonly watchers?: RunWatcherPort;
  /** Q7 delivery owner seam; absent hosts cannot start Notification turns. */
  readonly notifications?: NotificationDeliveryPort;
  /** B3d §19.1 usage projection, read through Supervision's public contract. */
  readonly usage?: RunUsageLookup;
  /** Emitted after a commit, never before it (§15). */
  readonly publish: (
    kind: string,
    payload: Readonly<Record<string, unknown>>,
    traceId?: TraceCorrelationId,
  ) => Promise<B3Result<RunEvent>>;
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
    const announced = await core.publish('agent.supervision.changed', {
      subjectAgentId: input.subjectAgentId, supervisor: input.supervisor,
    });
    if (!announced.ok) return b3fail(announced.error);
  }
  return written;
}

/**
 * `expiresWhenIssuerRunFinal`, at every place a Run becomes final.
 *
 * The result used to be discarded at all three call sites, so a Run could end
 * while the authority it handed out stayed live and nothing anywhere said so.
 * A failure here cannot un-finalise the Run — the Run IS over — but it is a
 * recovery item, and it is now named as one instead of vanishing.
 */
export async function expireAuthorityOf(
  core: RunsCore, agentRun: AgentRun,
): Promise<void> {
  const expired = await core.agents.expireGrantsOfRun(agentRun.id);
  if (expired.ok) return;
  await core.publish('runtime.recovery.required', {
    agentRunId: agentRun.id,
    reason: `authority outlived its Run: ${expired.error.message}`,
  });
}

/**
 * §8.1's cutoff, for a Run that has ended — by ANY road.
 *
 * §13.6 drains the endpoint on CONTINUATION, because that is where it is handed
 * to a successor. A plain stop has no successor and had no such step, so the
 * claim stayed `active` with no cutoff and an exact-Run Message aimed at a Run
 * that no longer exists was accepted and queued for the Agent — the silent
 * redirect §8.1 forbids, reached by never closing the endpoint at all.
 *
 * It lives beside `expireAuthorityOf` because it is the same sentence about a
 * different thing the Run held, and because the two roads out of a shift need
 * it equally: an explicit stop, and a Run reconciled after its Runtime died
 * (DEC-B3V4-23). Boot settled the Run and expired its grants and left the
 * endpoint advertising an Agent nobody was behind — exam row D2's stall.
 *
 * Only the claim belonging to THIS Run is touched: a continuation that already
 * moved the endpoint on leaves the successor holding it, and draining that
 * would silence a live Agent. Failure is logged rather than reversing the
 * ending — the PTY is dead and the grants are expired by this point, so
 * refusing to finish would leave a worse state than an endpoint that is one
 * reconcile behind.
 */
export async function closeEndpointOf(core: RunsCore, agentRun: AgentRun): Promise<void> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined) return;
  const current = await messaging.currentEndpoint(agentRun.agentId);
  if (!current.ok || current.value.claimId === null) return;
  if (current.value.agentRunId !== undefined
    && current.value.agentRunId !== String(agentRun.id)) return;
  const drained = await messaging.drain(current.value.claimId);
  if (!drained.ok) {
    console.error(
      `[agent-runtime] endpoint drain failed for run ${String(agentRun.id)} `
      + `(${drained.error.code}): ${drained.error.message}`,
    );
  }
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
    const announced = await core.publish('agent.run.lifecycle.changed', {
      agentRunId: agentRun.id,
      fromLifecycle: agentRun.lifecycle,
      toLifecycle: patch.lifecycle,
      activityGeneration: written.value.activityGeneration,
      uncertaintyCodes: written.value.uncertainty.map((item) => item.code),
      final: FINAL_LIFECYCLES.has(written.value.lifecycle),
    });
    if (!announced.ok) return b3fail(announced.error);
  }
  if (patch.activity !== undefined && patch.activity !== agentRun.activity) {
    const announced = await core.publish('agent.run.activity.changed', {
      agentRunId: agentRun.id,
      activity: patch.activity,
      activityGeneration: written.value.activityGeneration,
    });
    if (!announced.ok) return b3fail(announced.error);
  }
  return written;
}

// Starting the Run that replaces another (§13.6).
//
// Split from `continue.ts` so that file reads as the ORDER a continuation
// happens in, and this one reads as what actually starts. Re-entrant: it looks
// for the Run an earlier attempt reserved before it creates one.
import {
  b3fail, b3ok, mintAgentRunId, nowIsoUtc,
  type ActivityGeneration, type B3Result, type CommandContext,
  type ProviderSessionId, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { ContinueAgentInput } from '../contract/runs-api.js';
import type { LaunchPlanFacts } from '../contract/ports.js';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import { patchRun, type RunsCore } from './runs-context.js';
import { recoveryRequired, type Persisted } from './runs-store.js';
import { advance, completed } from './journal.js';

/**
 * The shape both halves of a continuation carry. It lives HERE, in the module
 * `continue.ts` depends on, rather than the other way round: the order-of-events
 * file may know how a replacement starts, but the starter must never need to
 * know the order. Defining it above the arrow keeps the dependency one-way.
 */
export interface ContinuationWork {
  readonly input: ContinueAgentInput;
  readonly oldRun: AgentRun;
  readonly operation: RunOperation;
  readonly reserved: ProviderSessionId;
  readonly epochId: RuntimeEpochId;
}

export async function startReplacement(
  core: RunsCore,
  context: CommandContext,
  work: ContinuationWork & { readonly plan: LaunchPlanFacts },
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation; resumeHandleUsed: boolean }>> {
  if (work.oldRun.providerSessionId === undefined) {
    return b3fail(recoveryRequired(work.operation.id, work.operation.currentStage,
      'headless transcript-first Runs continue through Messaging, not the terminal ladder'));
  }
  const session = await core.agents.getProviderSession(
    context.principal, work.oldRun.providerSessionId,
  );
  const oldNativeSessionId = session.ok ? session.value.providerNativeSessionId : '';

  // The replacement Run exists BEFORE its launch is assembled, because a Run
  // authenticates as itself with a credential minted for its own id. This used
  // to prepare first and pass `runtimeEnvironment: {}` — so every continued
  // Agent lost its identity, and a credential-less caller is the local human
  // with every scope Chris holds (§13.6, DEC-B3V4-05, red gate 5).
  const created = await reserveReplacementRun(core, context, work);
  if (!created.ok) return created;

  const reservedStage = await advance(core, work.operation, {
    stage: 'run-reserved', owner: 'agent-runtime', ownerObjectId: created.value.id,
  }, { newRunId: created.value.id });
  if (!reservedStage.ok) return reservedStage;

  const prepared = await core.providers.prepareContinuation({
    launchPlan: work.plan,
    mode: work.input.mode,
    agentRunId: created.value.id,
    reservedProviderSessionId: work.reserved,
    oldNativeSessionId,
    ...(work.input.handoverArtifactId === undefined
      ? {} : { handoverArtifactId: work.input.handoverArtifactId }),
    runtimeEnvironment: core.credentials.issue(created.value.id),
    columns: core.defaultViewport.columns,
    rows: core.defaultViewport.rows,
  });
  if (!prepared.ok) return prepared;

  const opened = await core.terminal.openManagedTerminal(context, {
    agentRunId: created.value.id,
    launchAuthorityRef: prepared.value.launchAuthorityRef,
    launchFingerprint: prepared.value.launchFingerprint,
    workingDirectory: work.plan.workingDirectory,
    columns: core.defaultViewport.columns,
    rows: core.defaultViewport.rows,
  });
  if (!opened.ok) return opened;

  const liveStage = await advance(core, reservedStage.value, {
    stage: 'terminal-live', owner: 'terminal', ownerObjectId: opened.value.id,
  });
  if (!liveStage.ok) return liveStage;

  const sessionStage = await bindReplacementSession(core, work, {
    operation: liveStage.value,
    providerNativeSessionId: prepared.value.providerNativeSessionId,
  });
  if (!sessionStage.ok) return sessionStage;

  const withTerminal = await patchRun(core, created.value, {
    terminalSessionId: opened.value.id,
  });
  if (!withTerminal.ok) return withTerminal;

  return b3ok({
    agentRun: withTerminal.value,
    operation: sessionStage.value,
    resumeHandleUsed: prepared.value.resumeHandleUsed,
  });
}


/**
 * The replacement Run record — or the one an earlier attempt already reserved.
 * A crash between reserving and launching must not mint a second Run (§20).
 */
async function reserveReplacementRun(
  core: RunsCore,
  context: CommandContext,
  work: ContinuationWork & { readonly plan: LaunchPlanFacts },
): Promise<B3Result<AgentRun>> {
  const earlier = completed(work.operation, 'run-reserved');
  if (earlier?.ownerObjectId !== undefined) {
    const found = await core.store.read<AgentRun>('agentRun', earlier.ownerObjectId);
    if (!found.ok) return found;
    if (found.value !== null) return b3ok(found.value);
    return b3fail(recoveryRequired(work.operation.id, 'run-reserved', 'the reserved Run vanished'));
  }
  const record: Persisted<AgentRun> = {
    kind: 'agentRun',
    id: mintAgentRunId(),
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    agentId: work.input.agentId,
    launchPlanId: work.plan.id,
    providerSessionId: work.reserved,
    lifecycle: 'provisioning',
    activity: 'idle',
    activityGeneration: 1 as ActivityGeneration,
    // A continuation keeps the surface it was asked from, not the old one's.
    launchSurface: work.oldRun.launchSurface,
    requestedBy: context.principal.id,
    rootTraceId: context.traceId,
    uncertainty: [],
  };
  return core.store.create<AgentRun>(context.principal.id, record as never, context.clientOpId);
}

/** The replacement's provider session, under the id reserved before it started. */
async function bindReplacementSession(
  core: RunsCore,
  work: ContinuationWork & { readonly plan: LaunchPlanFacts },
  input: { readonly operation: RunOperation; readonly providerNativeSessionId: string },
): Promise<B3Result<RunOperation>> {
  const native = input.providerNativeSessionId === '' ? null : input.providerNativeSessionId;
  const boundary = await core.providers.turnBoundaryCapability(work.plan.provider);
  if (!boundary.ok) return boundary;
  const bound = await core.agents.registerProviderSession({
    expectedProviderSessionId: work.reserved,
    agentId: work.input.agentId,
    provider: work.plan.provider,
    providerConversationId: native,
    providerResumeHandle: native,
    providerVersion: boundary.value.testedProviderVersion,
    discovery: { state: 'discovered' },
  });
  if (!bound.ok) return bound;
  return advance(core, input.operation, {
    stage: 'provider-session-recorded', owner: 'agents', ownerObjectId: bound.value.id,
  });
}

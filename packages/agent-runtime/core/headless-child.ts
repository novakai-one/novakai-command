// Spawning a headless child: no PTY, no terminal — the child is bootstrapped
// through its own transcript-first conversation and its brief is dispatched as
// a Message. These are the rungs of the spawn ladder that replace
// "open a terminal" when the child will never have one.
import {
  b3ok,
  type AgentId, type B3Result, type CommandContext,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts, SpawnAuthorityFacts } from '../contract/ports.js';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import { patchRun, type RunsCore } from './runs-context.js';
import { advance } from './journal.js';
import {
  ensureRunGrants, installWatchers, reserveRun,
} from './spawn-stages.js';

interface HeadlessChildInput {
  readonly agentId: AgentId;
  readonly plan: LaunchPlanFacts;
  readonly authority: SpawnAuthorityFacts & { readonly parentAgentId: AgentId };
  readonly operation: RunOperation;
  readonly displayName: string;
  readonly brief: string;
}

const HEADLESS_STAGES = [
  'endpoint-reserved', 'terminal-reserved', 'terminal-live',
  'provider-session-recorded', 'transcript-bound', 'endpoint-active',
  'skills-gate-prompt-sent', 'skills-gate-confirmed', 'supervised-work-released',
] as const;

/** Provision an authenticated child through one-shot Messaging, never a PTY. */
export async function provisionHeadlessChild(
  core: RunsCore,
  context: CommandContext,
  input: HeadlessChildInput,
): Promise<B3Result<{ agentRun: AgentRun; operation: RunOperation; response: string }>> {
  const reserved = await reserveRun(core, context, {
    agentId: input.agentId,
    plan: input.plan,
    authority: input.authority,
    operation: input.operation,
  });
  if (!reserved.ok) return reserved;

  const prepared = await prepareMessaging(core, context, input, reserved.value.agentRun);
  if (!prepared.ok) return prepared;
  const dispatched = await authorizeAndDispatch(
    core, context, input, reserved.value.agentRun, prepared.value.conversationId,
  );
  if (!dispatched.ok) return dispatched;

  const registered = await core.agents.registerProviderSession({
    expectedProviderSessionId: dispatched.value.providerSessionId,
    agentId: input.agentId,
    provider: input.plan.provider,
    providerConversationId: dispatched.value.providerResumeId,
    providerResumeHandle: dispatched.value.providerResumeId,
    providerVersion: 'unknown',
    discovery: { state: 'discovered' },
  });
  if (!registered.ok) return registered;

  const boundRun = await patchRun(core, reserved.value.agentRun, {
    providerSessionId: dispatched.value.providerSessionId,
  });
  if (!boundRun.ok) return boundRun;

  const operation = await recordHeadlessStages(
    core, reserved.value.operation, dispatched.value.sendId,
    dispatched.value.providerSessionId,
  );
  if (!operation.ok) return operation;
  const watched = await installWatchers(core, {
    agentRun: boundRun.value,
    plan: input.plan,
    operation: operation.value,
    recipient: { kind: 'agent', agentId: input.authority.parentAgentId },
    requestProvenance: {
      requestedBy: context.principal.id,
      traceId: context.traceId,
      clientOpId: context.clientOpId,
    },
  });
  return watched.ok
    ? b3ok({
        agentRun: boundRun.value,
        operation: watched.value,
        response: dispatched.value.response,
      })
    : watched;
}

async function prepareMessaging(
  core: RunsCore,
  context: CommandContext,
  input: HeadlessChildInput,
  agentRun: AgentRun,
) {
  return core.headlessChildMessaging!.prepare({
    agentId: input.agentId,
    parentAgentId: input.authority.parentAgentId,
    rootHumanPrincipalId: input.authority.rootHumanPrincipalId,
    provider: input.plan.provider,
    displayName: input.displayName,
    environment: core.credentials.issue(agentRun.id),
    clientOpId: context.clientOpId,
  });
}

async function authorizeAndDispatch(
  core: RunsCore,
  context: CommandContext,
  input: HeadlessChildInput,
  agentRun: AgentRun,
  conversationId: string,
) {
  const authorized = await ensureRunGrants(core, context, {
    agentRun,
    operation: input.operation,
    agentId: input.agentId,
    authority: input.authority,
    plan: input.plan,
  });
  if (!authorized.ok) return authorized;
  return core.headlessChildMessaging!.dispatchBrief({
    agentId: input.agentId,
    parentAgentId: input.authority.parentAgentId,
    conversationId,
    brief: input.brief,
    clientOpId: context.clientOpId,
  });
}

async function recordHeadlessStages(
  core: RunsCore,
  initial: RunOperation,
  sendId: string,
  providerSessionId: string,
): Promise<B3Result<RunOperation>> {
  let operation = initial;
  for (const stage of HEADLESS_STAGES) {
    const sent = stage === 'skills-gate-prompt-sent';
    const sessionRecorded = stage === 'provider-session-recorded';
    const recorded = await advance(core, operation, sent
      ? { stage, owner: 'messaging', ownerObjectId: sendId }
      : sessionRecorded
        ? { stage, owner: 'agents', ownerObjectId: providerSessionId }
      : {
          stage,
          owner: stage.startsWith('terminal') ? 'terminal' : 'agent-runtime',
          outcome: 'not-needed',
          notNeededBecause: 'transcript-first one-shot child bootstrap',
        });
    if (!recorded.ok) return recorded;
    operation = recorded.value;
  }
  return b3ok(operation);
}

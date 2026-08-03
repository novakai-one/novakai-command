import {
  b3err, b3fail, b3ok, canonicalRequestHash,
  type ActivityGeneration, type AgentId, type AgentRunId, type AuthenticatedPrincipal,
  type B3Result,
} from '@novakai/foundation/contract';
import type { RunEvent, RunUsageFacts } from '../contract/runs-api.js';
import type {
  RunConnectionSnapshot, RunOccurrenceEventBase, RunOccurrenceEventFacts,
} from '../../supervision/contract/index.js';
import { isRunDisconnectedEdge } from '../../supervision/contract/index.js';
import {
  type AgentRun, type RunOperation,
} from '../contract/runs.js';
import { requireRun, type RunsCore } from './runs-context.js';
import { findRetainedRunOccurrenceEvent } from './occurrence-event-retention.js';
import { usageFacts } from './usage-run-resolution.js';

async function eventRunId(core: RunsCore, event: RunEvent): Promise<B3Result<AgentRunId | null>> {
  const directRunId = event.payload['agentRunId'];
  if (typeof directRunId === 'string') return b3ok(directRunId as AgentRunId);
  if (event.kind !== 'agent.run.operation.stage.changed') return b3ok(null);
  const operationId = event.payload['operationId'];
  if (typeof operationId !== 'string') return b3ok(null);
  const operation = await core.store.read<RunOperation>('runOperation', operationId);
  if (!operation.ok) return b3fail(operation.error);
  if (operation.value === null) return b3ok(null);
  const targets = [...new Set([operation.value.oldRunId, operation.value.newRunId]
    .filter((candidate): candidate is AgentRunId => candidate !== undefined))];
  if (targets.length !== 1) {
    return b3fail(b3err(
      'RecoveryRequired',
      'the retained Runtime operation event does not resolve exactly one target Run',
      {
        stage: 'occurrence-derivation',
        eventId: event.eventId,
        operationId,
        resolvedTargetAgentRunIds: targets,
      },
      true,
    ));
  }
  return b3ok(targets[0]!);
}

function eventGeneration(event: RunEvent): ActivityGeneration | null {
  const payloadGeneration = event.payload['activityGeneration'];
  if (Number.isSafeInteger(payloadGeneration) && Number(payloadGeneration) >= 0) {
    return payloadGeneration as ActivityGeneration;
  }
  const current = event.payload['current'];
  if (event.kind !== 'agent.run.activity.changed'
    || current === null || typeof current !== 'object') return null;
  const currentGeneration = (current as Record<string, unknown>)['activityGeneration'];
  return Number.isSafeInteger(currentGeneration) && Number(currentGeneration) >= 0
    ? currentGeneration as ActivityGeneration
    : null;
}

function occurrenceBase(
  event: RunEvent,
  runFacts: RunUsageFacts,
  generation: ActivityGeneration | null,
): RunOccurrenceEventBase {
  return {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    committedAt: event.committedAt,
    sourceOwner: 'agent-runtime',
    agentRunId: runFacts.agentRunId,
    agentId: runFacts.agentId,
    providerSessionId: runFacts.providerSessionId,
    lifecycle: runFacts.lifecycle,
    final: runFacts.final,
    activityGeneration: generation ?? runFacts.activityGeneration,
    canonicalPayloadDigest: canonicalRequestHash(event.payload),
  };
}

function finalOccurrence(
  event: RunEvent,
  runFacts: RunUsageFacts,
  generation: ActivityGeneration | null,
  base: RunOccurrenceEventBase,
): B3Result<RunOccurrenceEventFacts | null> {
  const toLifecycle = event.payload['toLifecycle'];
  if (toLifecycle !== 'stopped' && toLifecycle !== 'failed' && toLifecycle !== 'interrupted') {
    return b3ok(null);
  }
  if (!runFacts.final || runFacts.lifecycle !== toLifecycle) return b3ok(null);
  if (generation === null) {
    return b3fail(b3err(
      'RecoveryRequired', 'the retained final event lacks its immutable activity generation',
      { stage: 'occurrence-derivation', eventId: event.eventId }, true,
    ));
  }
  const reconciledFinal = event.payload['reconciledFinal'];
  if ((toLifecycle === 'interrupted' && reconciledFinal !== true)
    || (toLifecycle !== 'interrupted' && reconciledFinal !== undefined)) {
    return b3fail(b3err(
      'RecoveryRequired', 'the retained final event has an invalid reconciledFinal discriminator',
      { stage: 'occurrence-derivation', eventId: event.eventId, toLifecycle }, true,
    ));
  }
  return b3ok({
    ...base,
    kind: 'agent.run.lifecycle.changed',
    occurrenceKind: 'run-final',
    occurrence: toLifecycle === 'interrupted'
      ? { toLifecycle, reconciledFinal: true }
      : { toLifecycle },
  });
}

function disconnectedOccurrence(
  event: RunEvent,
  runFacts: RunUsageFacts,
  generation: ActivityGeneration | null,
  base: RunOccurrenceEventBase,
): B3Result<RunOccurrenceEventFacts | null> {
  if (runFacts.final) return b3ok(null);
  const previous = event.payload['previous'];
  const current = event.payload['current'];
  const currentGeneration = current !== null && typeof current === 'object'
    ? (current as Record<string, unknown>)['activityGeneration'] : null;
  if (previous === null || typeof previous !== 'object' || Array.isArray(previous)
    || current === null || typeof current !== 'object' || Array.isArray(current)
    || generation === null || Number(currentGeneration) !== Number(generation)) {
    return b3fail(b3err(
      'RecoveryRequired', 'the retained activity event has corrupt occurrence snapshots',
      { stage: 'occurrence-derivation', eventId: event.eventId }, true,
    ));
  }
  const snapshots = [previous, current] as Readonly<Record<string, unknown>>[];
  for (const snapshot of snapshots) {
    const uncertaintyCodes = snapshot['uncertaintyCodes'];
    if (!['idle', 'working', 'waiting-provider', 'waiting-input', 'interrupting', 'unknown']
      .includes(String(snapshot['activity']))
      || !Number.isSafeInteger(snapshot['activityGeneration'])
      || Number(snapshot['activityGeneration']) < 0
      || typeof snapshot['observedAt'] !== 'string'
      || !Array.isArray(uncertaintyCodes)
      || !uncertaintyCodes.every((code) => typeof code === 'string')
      || new Set(uncertaintyCodes).size !== uncertaintyCodes.length
      || [...uncertaintyCodes].sort().some(
        (code, index) => code !== uncertaintyCodes[index],
      )) {
      return b3fail(b3err(
        'RecoveryRequired', 'the retained activity event has invalid connection snapshots',
        { stage: 'occurrence-derivation', eventId: event.eventId }, true,
      ));
    }
  }
  if (!isRunDisconnectedEdge(
    previous as unknown as RunConnectionSnapshot,
    current as unknown as RunConnectionSnapshot,
  )) return b3ok(null);
  return b3ok({
    ...base,
    kind: 'agent.run.activity.changed',
    occurrenceKind: 'run-disconnected',
    occurrence: { previous, current },
  } as RunOccurrenceEventFacts);
}

function helpOccurrence(
  event: RunEvent,
  runFacts: RunUsageFacts,
  base: RunOccurrenceEventBase,
): B3Result<RunOccurrenceEventFacts | null> {
  const reason = event.payload['reason'];
  const evidenceRefs = event.payload['evidenceRefs'];
  if (typeof reason !== 'string' || reason.trim() === ''
    || !Array.isArray(evidenceRefs) || evidenceRefs.length === 0
    || !evidenceRefs.every((evidenceRef) => typeof evidenceRef === 'string')) {
    return b3fail(b3err(
      'RecoveryRequired', 'the retained child recovery event lacks typed recovery evidence',
      { stage: 'occurrence-derivation', eventId: event.eventId }, true,
    ));
  }
  if (runFacts.lifecycle !== 'recovery-required') return b3ok(null);
  return b3ok({
    ...base,
    kind: 'runtime.recovery.required',
    occurrenceKind: 'child-needs-help',
    occurrence: {
      recoveryReason: reason,
      evidenceRefs,
    },
  });
}

async function failedOperationOccurrence(
  core: RunsCore,
  event: RunEvent,
  base: RunOccurrenceEventBase,
): Promise<B3Result<RunOccurrenceEventFacts | null>> {
  const operationId = event.payload['operationId'];
  if (typeof operationId !== 'string') return b3ok(null);
  const operation = await core.store.read<RunOperation>('runOperation', operationId);
  if (!operation.ok || operation.value === null) return operation.ok ? b3ok(null) : operation;
  if (operation.value.state !== 'recovery-required') return b3ok(null);
  return b3ok({
    ...base,
    kind: 'agent.run.operation.stage.changed',
    occurrenceKind: 'operation-failed',
    occurrence: {
      runOperationId: operation.value.id,
      terminalState: 'recovery-required',
      reason: String(event.payload['reason'] ?? 'Runtime operation requires recovery'),
    },
  });
}

function usageOccurrence(
  event: RunEvent,
  base: RunOccurrenceEventBase,
): B3Result<RunOccurrenceEventFacts | null> {
  const evidenceRef = event.payload['qualifyingEvidenceRef'];
  return typeof evidenceRef !== 'string'
    ? b3ok(null)
    : b3ok({
        ...base,
        kind: 'agent.run.usage.changed',
        occurrenceKind: 'usage-generation',
        occurrence: { qualifyingEvidenceRef: evidenceRef as never },
      });
}

async function occurrenceForKind(
  core: RunsCore,
  event: RunEvent,
  runFacts: RunUsageFacts,
): Promise<B3Result<RunOccurrenceEventFacts | null>> {
  const generation = eventGeneration(event); const base = occurrenceBase(event, runFacts, generation);
  switch (event.kind) {
    case 'agent.run.lifecycle.changed': return finalOccurrence(event, runFacts, generation, base);
    case 'agent.run.activity.changed': return disconnectedOccurrence(
      event, runFacts, generation, base,
    );
    case 'runtime.recovery.required': return helpOccurrence(event, runFacts, base);
    case 'agent.run.operation.stage.changed': return failedOperationOccurrence(core, event, base);
    case 'agent.run.usage.changed': return usageOccurrence(event, base);
    default: return b3ok(null);
  }
}

async function resolveOccurrenceRunFacts(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  eventId: string,
  agentRunId: AgentRunId,
  retainedFacts: RunUsageFacts | undefined,
): Promise<B3Result<RunUsageFacts>> {
  if (retainedFacts === undefined) return getUsageRun(core, principal, agentRunId);
  if (retainedFacts.agentRunId !== agentRunId) {
    return b3fail(b3err(
      'RecoveryRequired', 'retained event/Run snapshot mismatch',
      { stage: 'occurrence-derivation', eventId }, true,
    ));
  }
  const visible = await core.agents.getAgent(principal, retainedFacts.agentId);
  return visible.ok ? b3ok(retainedFacts) : visible;
}

/** Exact retained Runtime event lookup enriched from durable owner records. */
export async function getRunOccurrenceEvent(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  eventId: string,
): Promise<B3Result<RunOccurrenceEventFacts | null>> {
  const found = await findRetainedRunOccurrenceEvent(core.store, eventId);
  if (!found.ok) return b3fail(found.error);
  if (found.value === null) {
    return b3fail(b3err(
      'RuntimeUnavailable',
      'the exact occurrence event is not retained; absence cannot be proven after eviction or restart',
      { stage: 'occurrence-derivation', eventId, reason: 'retained-event-completeness-unproven' },
      true,
    ));
  }
  const event = found.value.event;
  if (event.sourceOwner !== 'agent-runtime') return b3ok(null);
  const resolvedRunId = await eventRunId(core, event);
  if (!resolvedRunId.ok) return b3fail(resolvedRunId.error);
  if (resolvedRunId.value === null) return b3ok(null);
  const runFacts = await resolveOccurrenceRunFacts(
    core, principal, eventId, resolvedRunId.value, found.value.runFacts,
  );
  return runFacts.ok ? occurrenceForKind(core, event, runFacts.value) : runFacts;
}

/** Composition-only Runtime read that avoids Runtime→Supervision→Runtime recursion. */
export async function getUsageRun(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentRunId: AgentRunId,
): Promise<B3Result<RunUsageFacts>> {
  const agentRun = await requireRun(core, agentRunId);
  if (!agentRun.ok) return agentRun;
  const visible = await core.agents.getAgent(principal, agentRun.value.agentId);
  return visible.ok ? b3ok(usageFacts(agentRun.value)) : visible;
}

/** All Runtime-owned Run facts for one visible stable Agent. */
export async function listUsageRuns(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentId: AgentId,
): Promise<B3Result<readonly RunUsageFacts[]>> {
  const visible = await core.agents.getAgent(principal, agentId);
  if (!visible.ok) return visible;
  const storedRuns = await core.store.list<AgentRun>('agentRun', { agentId });
  return storedRuns.ok ? b3ok(storedRuns.value.map(usageFacts)) : storedRuns;
}

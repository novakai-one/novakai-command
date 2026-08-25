import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderSourceStat } from '../../contract/ports/provider-transcript-source.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendJournal } from '../../contract/records/send-journal.js';
import type { ProviderName } from '../../contract/types.js';

const dispatchFloor = (journal: SendJournal): string =>
  journal.attempts.at(-1)?.dispatchedAt ?? journal.updatedAt;

const historicalDiscoveryLimit = 8;

async function pendingFloors(
  journals: readonly SendJournal[],
  directory: AgentDirectory | undefined,
): Promise<ReadonlyMap<ProviderName, string>> {
  const floors = new Map<ProviderName, string>();
  if (directory === undefined) return floors;
  for (const journal of journals) {
    if (journal.state !== 'dispatching'
      && journal.state !== 'awaiting-session-assignment') continue;
    const agent = await directory.get(journal.targetAgentId);
    if (agent === null) continue;
    const floor = dispatchFloor(journal);
    const current = floors.get(agent.provider);
    if (current === undefined || floor < current) floors.set(agent.provider, floor);
  }
  return floors;
}

/** Selects active, adoptable or fresh evidence before any provider bytes are opened. */
export async function selectSourcesForIngest(input: {
  readonly sources: readonly ProviderSourceStat[];
  readonly sessions: readonly ProviderSession[];
  readonly journals: readonly SendJournal[];
  readonly discoveryFloor: string;
  readonly directory?: AgentDirectory;
}): Promise<readonly ProviderSourceStat[]> {
  const known = new Set(input.sessions.flatMap((session) => session.sourceIds));
  const active = new Set(input.sessions
    .filter((session) => session.agentId !== undefined)
    .flatMap((session) => session.sourceIds));
  const awaitingAdoption = new Set(input.sessions
    .filter((session) => session.agentId === undefined)
    .flatMap((session) => session.sourceIds));
  const pending = await pendingFloors(input.journals, input.directory);
  const prioritized = input.sources
    .filter((source) => {
      const pendingFloor = pending.get(source.provider);
      return active.has(source.sourceId)
        || (source.adoptionEligible && awaitingAdoption.has(source.sourceId))
        || source.modifiedAt >= input.discoveryFloor
        || (pendingFloor !== undefined && source.modifiedAt >= pendingFloor);
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  if (prioritized.length > 0) return prioritized;
  return input.sources
    .filter((source) => !known.has(source.sourceId))
    .sort((left, right) => {
      if (left.adoptionEligible !== right.adoptionEligible) {
        return left.adoptionEligible ? -1 : 1;
      }
      return right.modifiedAt.localeCompare(left.modifiedAt);
    })
    .slice(0, historicalDiscoveryLimit);
}

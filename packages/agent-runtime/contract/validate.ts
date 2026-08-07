// Runtime-host boundary validation (§3.2, §4.2 MUST).
//
// A stop is the one command here that can end things a person cares about, so
// what it is aimed at has to be an epoch id — not a terminal id that happens to
// be a string, which the old cast let through as a merely stale epoch.
import {
  readBoundary, type AgentRunId, type B3Result, type RuntimeEpochId,
} from '@novakai/foundation/contract';
import type { RequestRuntimeStopInput } from './types.js';

const LIVE_RUN_POLICIES = ['refuse', 'stop-explicitly'] as const;

export function readRequestRuntimeStopInput(
  payload: unknown,
): B3Result<RequestRuntimeStopInput> {
  return readBoundary(payload, (field) => {
    const confirmed = field.given('confirmedRunIds');
    const confirmedRunIds: AgentRunId[] = [];
    if (confirmed !== undefined) {
      if (!Array.isArray(confirmed)) {
        field.reject('confirmedRunIds', 'must be an array of agentRun identifiers');
      } else {
        for (const [index, candidate] of confirmed.entries()) {
          const runIds = field.nested('confirmedRunIds');
          void candidate;
          confirmedRunIds.push(runIds.id<AgentRunId>(String(index), 'agentRun'));
        }
      }
    }
    return {
      expectedEpochId: field.id<RuntimeEpochId>('expectedEpochId', 'runtimeEpoch'),
      liveRuns: field.choice('liveRuns', LIVE_RUN_POLICIES),
      ...(confirmed === undefined ? {} : { confirmedRunIds }),
    };
  });
}

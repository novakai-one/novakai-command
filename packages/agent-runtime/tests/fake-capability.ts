// A recoverable capability that records what the Runtime asked it to do.
import { b3ok, type RuntimeEpochId, type TerminalSessionId } from '@novakai/foundation/contract';
import type { RecoverableCapability, RuntimeCensus } from '../contract/index.js';

export interface RecordingCapability extends RecoverableCapability {
  readonly reconciledEpochs: readonly RuntimeEpochId[];
  readonly stoppedSessionIds: readonly TerminalSessionId[];
  setCensus(census: RuntimeCensus): void;
}

export function recordingCapability(name = 'terminal'): RecordingCapability {
  const reconciledEpochs: RuntimeEpochId[] = [];
  const stoppedSessionIds: TerminalSessionId[] = [];
  let census: RuntimeCensus = {
    liveTerminalSessionIds: [], attachedControllerCount: 0, recoveryRequiredCount: 0,
    recoveryRequiredSessionIds: [],
  };
  return {
    name,
    reconciledEpochs,
    stoppedSessionIds,
    setCensus(next: RuntimeCensus): void { census = next; },
    async reconcile(_context, activeRuntimeEpochId) {
      reconciledEpochs.push(activeRuntimeEpochId);
      return b3ok({ reconciledSessionIds: [] });
    },
    async census() {
      return b3ok(census);
    },
    async stopSession(_context, _epochId, terminalSessionId) {
      stoppedSessionIds.push(terminalSessionId);
      census = {
        ...census,
        liveTerminalSessionIds: census.liveTerminalSessionIds.filter(
          (item) => item !== terminalSessionId,
        ),
      };
      return b3ok(null);
    },
  };
}

// The Runtime host composition root.
//
// Three jobs, and nothing else:
//   1. hold the OS single-instance lease, so one machine has one runtime;
//   2. own the durable epoch fence every Runtime-owned mutation carries;
//   3. reconcile honestly after a restart, without ever claiming a process
//      kept running while nobody was watching.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type RuntimeEpochId, type SystemCommandContext, type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  InstanceLease, RecoverableCapability, RequestRuntimeStopInput, RuntimeCensus,
  RuntimeDoctorReport, RuntimeEpoch, RuntimeHostContract, RuntimeStatus, RuntimeStopOutcome,
} from '../contract/types.js';
import { createEpochStore, type EpochStore, type EpochStoreOptions } from './epochs.js';

export interface ComposeRuntimeHostOptions extends EpochStoreOptions {
  readonly lease: InstanceLease;
  readonly hostVersion: string;
  readonly hostPid?: number;
  readonly capabilities?: readonly RecoverableCapability[];
}

export function composeRuntimeHost(options: ComposeRuntimeHostOptions): RuntimeHostContract {
  const epochs: EpochStore = createEpochStore(options);
  const capabilities = options.capabilities ?? [];
  const hostPid = options.hostPid ?? process.pid;
  let owned: RuntimeEpoch | null = null;
  /** What another process's runtime is running, for honest diagnostics only. */
  let observedActiveEpochId: RuntimeEpochId | null = null;
  let ensuring: Promise<B3Result<RuntimeStatus>> | null = null;

  function systemContext(): SystemCommandContext<'sys_agent_runtime'> {
    return {
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    };
  }

  async function censusTotal(): Promise<B3Result<RuntimeCensus>> {
    const sessions: TerminalSessionId[] = [];
    const recovering: TerminalSessionId[] = [];
    const refs: string[] = [];
    let controllers = 0;
    let recoveringCount = 0;
    let runs = 0;
    for (const capability of capabilities) {
      const counted = await capability.census();
      if (!counted.ok) return counted;
      sessions.push(...counted.value.liveTerminalSessionIds);
      recovering.push(...counted.value.recoveryRequiredSessionIds);
      refs.push(...counted.value.recoveryRequiredRefs ?? []);
      controllers += counted.value.attachedControllerCount;
      recoveringCount += counted.value.recoveryRequiredCount;
      runs += counted.value.liveAgentRunCount ?? 0;
    }
    return b3ok({
      liveTerminalSessionIds: sessions,
      attachedControllerCount: controllers,
      recoveryRequiredCount: recoveringCount,
      recoveryRequiredSessionIds: recovering,
      liveAgentRunCount: runs,
      recoveryRequiredRefs: refs,
    });
  }

  async function statusFrom(
    epoch: RuntimeEpoch, ownedByThisProcess: boolean,
  ): Promise<B3Result<RuntimeStatus>> {
    const counted = await censusTotal();
    if (!counted.ok) return counted;
    return b3ok({
      activeEpochId: epoch.id,
      state: 'active',
      version: epoch.hostVersion,
      startedAt: epoch.startedAt,
      recoveryRequiredCount: counted.value.recoveryRequiredCount,
      liveAgentRunCount: counted.value.liveAgentRunCount ?? 0,
      liveTerminalSessionCount: counted.value.liveTerminalSessionIds.length,
      attachedControllerCount: counted.value.attachedControllerCount,
      ownedByThisProcess,
    });
  }

  async function takeOverOrObserve(): Promise<B3Result<RuntimeStatus>> {
    const taken = options.lease.acquire();
    if (!taken.held) {
      // Another live process owns this machine's runtime. Converge on it:
      // report its truth, mint nothing, and stay unable to mutate.
      const current = await epochs.active();
      if (!current.ok) return current;
      if (current.value === null) {
        return b3fail(b3err('RuntimeUnavailable',
          `process ${taken.holderPid} holds the runtime lease but no active epoch is recorded`,
          { reason: 'lease-held-without-epoch' }, true));
      }
      owned = null;
      observedActiveEpochId = current.value.id;
      return statusFrom(current.value, false);
    }

    const current = await epochs.active();
    if (!current.ok) return current;
    if (current.value !== null && current.value.hostPid === hostPid) {
      // Already ours: ensure is idempotent and does NOT re-run recovery.
      owned = current.value;
      return statusFrom(current.value, true);
    }

    const advanced = await epochs.advance(hostPid, options.hostVersion);
    if (!advanced.ok) return advanced;
    owned = advanced.value;
    const recovered = await recoverInto(advanced.value.id);
    if (!recovered.ok) return recovered;
    return statusFrom(advanced.value, true);
  }

  /** Boot recovery: ask each capability what is honestly true after the restart. */
  async function recoverInto(activeEpochId: RuntimeEpochId): Promise<B3Result<null>> {
    for (const capability of capabilities) {
      const reconciled = await capability.reconcile(systemContext(), activeEpochId);
      if (!reconciled.ok) return reconciled;
    }
    return b3ok(null);
  }

  /**
   * Three genuinely different answers, and the difference matters
   * to whoever is reading the error:
   *   - no runtime anywhere      → RuntimeUnavailable
   *   - a runtime, but not ours  → StaleRuntimeEpoch (naming the live one)
   *   - ours, but an old epoch   → StaleRuntimeEpoch (naming the current one)
   */
  function assertActive(epochId?: RuntimeEpochId): B3Result<RuntimeEpochId> {
    const holds = options.lease.heldByThisProcess();
    if (holds && owned !== null) {
      if (epochId === undefined || epochId === owned.id) return b3ok(owned.id);
      return b3fail(b3err('StaleRuntimeEpoch', 'that runtime epoch is no longer active',
        { received: epochId, active: owned.id }, true));
    }
    const liveElsewhere = options.lease.holderAlive();
    if (liveElsewhere) {
      return b3fail(b3err('StaleRuntimeEpoch',
        `process ${String(options.lease.holderPid())} owns the local runtime; this process may report but not mutate`,
        { received: epochId ?? null, active: observedActiveEpochId }, true));
    }
    return b3fail(b3err('RuntimeUnavailable', 'the local runtime has not been started',
      { reason: 'no-active-epoch' }, true));
  }

  return {
    fence: {
      activeEpochId: () => (options.lease.heldByThisProcess() ? owned?.id ?? null : null),
      assertActive,
    },

    async ensureLocalRuntime(context: CommandContext) {
      void context;
      // Concurrent ensures inside one process share ONE attempt, so they cannot
      // race each other into two epochs.
      if (ensuring) return ensuring;
      ensuring = takeOverOrObserve().finally(() => { ensuring = null; });
      return ensuring;
    },

    async getRuntimeStatus(principal: AuthenticatedPrincipal) {
      void principal;
      const current = await epochs.active();
      if (!current.ok) return current;
      if (current.value === null) {
        return b3fail(b3err('RuntimeUnavailable', 'no runtime has been started on this machine',
          { reason: 'no-active-epoch' }, true));
      }
      return statusFrom(current.value, options.lease.heldByThisProcess() && owned !== null);
    },

    async runtimeDoctor(principal: AuthenticatedPrincipal) {
      void principal;
      return buildDoctorReport(epochs, options.lease, hostPid, capabilities);
    },

    async requestRuntimeStop(context: CommandContext, input: RequestRuntimeStopInput) {
      void context;
      const fenced = assertActive(input.expectedEpochId);
      if (!fenced.ok) return fenced;
      const current = owned;
      if (current === null) {
        return b3fail(b3err('RuntimeUnavailable', 'the local runtime has not been started',
          { reason: 'no-active-epoch' }, true));
      }
      return stopRuntime(
        { epochs, lease: options.lease, capabilities, systemContext },
        current, input, () => { owned = null; },
      );
    },

    async shutdown() {
      const current = owned;
      owned = null;
      if (current) await epochs.settle(current, 'stopped');
      options.lease.release();
    },
  };
}

interface StopWiring {
  readonly epochs: EpochStore;
  readonly lease: InstanceLease;
  readonly capabilities: readonly RecoverableCapability[];
  readonly systemContext: () => SystemCommandContext<'sys_agent_runtime'>;
}

/**
 * A runtime stop is an explicit, authorised choice — never implied by a
 * window closing. `refuse` changes nothing and names what is still live;
 * `stop-explicitly` stops those sessions through each capability's own
 * lifecycle authority, then drains this epoch.
 */
async function stopRuntime(
  wiring: StopWiring,
  epoch: RuntimeEpoch,
  input: RequestRuntimeStopInput,
  release: () => void,
): Promise<B3Result<RuntimeStopOutcome>> {
  const live = await liveSessionIds(wiring.capabilities);
  if (!live.ok) return live;

  if (input.liveRuns === 'refuse' && live.value.length > 0) {
    return b3ok(stopOutcome(epoch, { refused: live.value, stopped: [], didStop: false }));
  }

  const stopped = await stopEverySession(wiring, epoch);
  if (!stopped.ok) return stopped;

  const drained = await wiring.epochs.settle(epoch, 'stopped');
  if (!drained.ok) return drained;
  release();
  wiring.lease.release();
  return b3ok(stopOutcome(epoch, { refused: [], stopped: stopped.value, didStop: true }));
}

async function stopEverySession(
  wiring: StopWiring, epoch: RuntimeEpoch,
): Promise<B3Result<readonly TerminalSessionId[]>> {
  const stopped: TerminalSessionId[] = [];
  for (const capability of wiring.capabilities) {
    const counted = await capability.census();
    if (!counted.ok) return counted;
    for (const sessionId of counted.value.liveTerminalSessionIds) {
      const ended = await capability.stopSession(wiring.systemContext(), epoch.id, sessionId);
      if (!ended.ok) return ended;
      stopped.push(sessionId);
    }
  }
  return b3ok(stopped);
}

async function liveSessionIds(
  capabilities: readonly RecoverableCapability[],
): Promise<B3Result<readonly TerminalSessionId[]>> {
  const live: TerminalSessionId[] = [];
  for (const capability of capabilities) {
    const counted = await capability.census();
    if (!counted.ok) return counted;
    live.push(...counted.value.liveTerminalSessionIds);
  }
  return b3ok(live);
}

/** The host stop pre-dates Agent Runs, so the Run lists are empty as a fact, not a gap. */
function stopOutcome(
  epoch: RuntimeEpoch,
  outcome: {
    refused: readonly TerminalSessionId[];
    stopped: readonly TerminalSessionId[];
    didStop: boolean;
  },
): RuntimeStopOutcome {
  const noRuns: readonly AgentRunId[] = [];
  return {
    stoppedEpochId: epoch.id,
    stoppedRunIds: noRuns,
    refusedLiveRunIds: noRuns,
    refusedTerminalSessionIds: outcome.refused,
    stoppedTerminalSessionIds: outcome.stopped,
    stopped: outcome.didStop,
  };
}

async function buildDoctorReport(
  epochs: EpochStore,
  lease: InstanceLease,
  hostPid: number,
  capabilities: readonly RecoverableCapability[],
): Promise<B3Result<RuntimeDoctorReport>> {
  const every = await epochs.everyEpoch();
  if (!every.ok) return every;
  const current = await epochs.active();
  if (!current.ok) return current;
  const surveyed = await surveyCapabilities(capabilities);
  if (!surveyed.ok) return surveyed;

  return b3ok({
    ownedByThisProcess: lease.heldByThisProcess(),
    hostPid,
    leaseHolderPid: lease.holderPid(),
    leaseHolderAlive: lease.holderAlive(),
    activeEpoch: current.value,
    supersededEpochs: every.value.filter((item) => item.state === 'stale').length,
    sessionsNeedingRecovery: surveyed.value.sessionsNeedingRecovery,
    findings: [
      ...ownershipFindings(lease),
      ...(current.value === null ? ['no active runtime epoch is recorded'] : []),
      ...surveyed.value.findings,
    ],
  });
}

function ownershipFindings(lease: InstanceLease): readonly string[] {
  if (lease.heldByThisProcess()) return [];
  const holderPid = lease.holderPid();
  return [holderPid === null
    ? 'no process currently holds the runtime lease'
    : `process ${holderPid} holds the runtime lease; this process may report but not mutate`];
}

async function surveyCapabilities(
  capabilities: readonly RecoverableCapability[],
): Promise<B3Result<{
  readonly sessionsNeedingRecovery: readonly TerminalSessionId[];
  readonly findings: readonly string[];
}>> {
  const sessionsNeedingRecovery: TerminalSessionId[] = [];
  const findings: string[] = [];
  for (const capability of capabilities) {
    const counted = await capability.census();
    if (!counted.ok) return counted;
    sessionsNeedingRecovery.push(...counted.value.recoveryRequiredSessionIds);
    if (counted.value.recoveryRequiredCount > 0) {
      const named = [
        ...counted.value.recoveryRequiredSessionIds,
        ...counted.value.recoveryRequiredRefs ?? [],
      ];
      findings.push(
        `${capability.name}: ${counted.value.recoveryRequiredCount} need(s) recovery`
        + (named.length > 0 ? ` — ${named.join(', ')}` : ''),
      );
    }
  }
  return b3ok({ sessionsNeedingRecovery, findings });
}

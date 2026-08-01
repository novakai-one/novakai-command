// The Runtime host's records, API and seams.
//
// Kept apart from contract/index.ts so the core can import these WITHOUT
// importing the door that re-exports the core — the shape that would otherwise
// be a genuine import cycle (red gate 26).
//
// B3a scope: the Runtime HOST. Who owns this machine's Novakai runtime, which
// epoch is active, and what is honestly true after a restart. Agent Runs,
// roles, family and delegation arrive in B3b and do not reopen this door.
import type {
  AgentRunId, AuthenticatedPrincipal, B3Result, CommandContext, IsoUtc,
  RecordEnvelope, RuntimeEpochId, SystemCommandContext, TerminalSessionId,
} from '@novakai/foundation/contract';

export type RuntimeEpochState =
  | 'starting' | 'active' | 'draining' | 'stopped' | 'failed' | 'stale';

/**
 * DEC-B3V4-27. The durable fence that makes split-brain impossible: exactly one
 * epoch is `active`, and every Runtime-owned mutation carries it.
 *
 * Pass 2 names this record and its states but not its payload; these fields are
 * this build's choice and are flagged in the slice report.
 */
export interface RuntimeEpoch extends RecordEnvelope<RuntimeEpochId, 'runtimeEpoch'> {
  readonly state: RuntimeEpochState;
  readonly hostPid: number;
  readonly hostVersion: string;
  readonly startedAt: IsoUtc;
  readonly endedAt?: IsoUtc;
  readonly supersededByEpochId?: RuntimeEpochId;
}

export interface RuntimeStatus {
  readonly activeEpochId: RuntimeEpochId;
  readonly state: 'starting' | 'active' | 'recovering' | 'draining';
  readonly version: string;
  readonly startedAt: IsoUtc;
  readonly recoveryRequiredCount: number;
  readonly liveAgentRunCount: number;
  readonly liveTerminalSessionCount: number;
  readonly attachedControllerCount: number;
  /**
   * Whether THIS process holds the OS single-instance lease. A process that
   * does not may report status; it may not mutate (§13.1 rule 5).
   */
  readonly ownedByThisProcess: boolean;
}

export interface RequestRuntimeStopInput {
  readonly expectedEpochId: RuntimeEpochId;
  readonly liveRuns: 'refuse' | 'stop-explicitly';
  readonly confirmedRunIds?: readonly AgentRunId[];
}

export interface RuntimeStopOutcome {
  readonly stoppedEpochId: RuntimeEpochId;
  readonly stoppedRunIds: readonly AgentRunId[];
  readonly refusedLiveRunIds: readonly AgentRunId[];
  /**
   * Additive for B3a (§3.5): no Agent Runs exist yet, so the live things a
   * stop must not silently kill are terminal sessions. `refuse` reports them
   * and changes nothing; `stop-explicitly` stops them and lists them.
   */
  readonly refusedTerminalSessionIds: readonly TerminalSessionId[];
  readonly stoppedTerminalSessionIds: readonly TerminalSessionId[];
  readonly stopped: boolean;
}

export interface RuntimeHostCommands {
  ensureLocalRuntime(context: CommandContext): Promise<B3Result<RuntimeStatus>>;
  requestRuntimeStop(
    context: CommandContext, input: RequestRuntimeStopInput,
  ): Promise<B3Result<RuntimeStopOutcome>>;
}

export interface RuntimeHostQueries {
  getRuntimeStatus(principal: AuthenticatedPrincipal): Promise<B3Result<RuntimeStatus>>;
  /** Everything `nvk runtime doctor` needs to explain the machine's state. */
  runtimeDoctor(principal: AuthenticatedPrincipal): Promise<B3Result<RuntimeDoctorReport>>;
}

export interface RuntimeDoctorReport {
  readonly ownedByThisProcess: boolean;
  readonly hostPid: number;
  readonly leaseHolderPid: number | null;
  readonly leaseHolderAlive: boolean;
  readonly activeEpoch: RuntimeEpoch | null;
  readonly supersededEpochs: number;
  readonly sessionsNeedingRecovery: readonly TerminalSessionId[];
  readonly findings: readonly string[];
}

export type RuntimeHostContract = RuntimeHostCommands & RuntimeHostQueries & {
  /**
   * The fence handed to every capability the Runtime owns. Terminal takes this
   * and refuses to manage a PTY for anyone but the live, owning epoch.
   */
  readonly fence: {
    activeEpochId(): RuntimeEpochId | null;
    assertActive(epochId?: RuntimeEpochId): B3Result<RuntimeEpochId>;
  };
  /** Release the OS lease. Never stops anything the Runtime owns. */
  shutdown(): Promise<void>;
};

// ── Seams ──────────────────────────────────────────────────────────────────

/** The OS single-instance lease (DEC-B3V4-27 step 1). */
export interface InstanceLease {
  /** Take the lease, stealing it only from a process that is provably gone. */
  acquire(): { readonly held: true } | { readonly held: false; readonly holderPid: number };
  release(): void;
  heldByThisProcess(): boolean;
  holderPid(): number | null;
  holderAlive(): boolean;
}

/**
 * A capability the Runtime must reconcile after a restart. Narrow on purpose:
 * Agent Runtime never learns how Terminal stores anything, and Terminal never
 * imports Agent Runtime.
 */
export interface RecoverableCapability {
  readonly name: string;
  reconcile(
    context: SystemCommandContext<'sys_agent_runtime'>, activeRuntimeEpochId: RuntimeEpochId,
  ): Promise<B3Result<{ readonly reconciledSessionIds: readonly TerminalSessionId[] }>>;
  /** What the Runtime is currently responsible for, for honest status. */
  census(): Promise<B3Result<RuntimeCensus>>;
  /** Stop one live session through that capability's own lifecycle authority. */
  stopSession(
    context: SystemCommandContext<'sys_agent_runtime'>,
    activeRuntimeEpochId: RuntimeEpochId,
    terminalSessionId: TerminalSessionId,
  ): Promise<B3Result<null>>;
}

export interface RuntimeCensus {
  readonly liveTerminalSessionIds: readonly TerminalSessionId[];
  readonly attachedControllerCount: number;
  readonly recoveryRequiredCount: number;
  /** Named, not just counted, so `nvk runtime doctor` can point at them. */
  readonly recoveryRequiredSessionIds: readonly TerminalSessionId[];
  /**
   * Additive (§3.5). Runs are not sessions, and a Runtime that could only count
   * terminal sessions reported `liveAgentRunCount: 0` while three Agents were
   * running — and `recoveryRequiredCount: 0` over stranded operations, which is
   * the §24.5 honesty failure the hold-out named.
   */
  readonly liveAgentRunCount?: number;
  /** Whatever needs recovery, by id, when it is not a terminal session. */
  readonly recoveryRequiredRefs?: readonly string[];
}

/**
 * Host doorway for the Agent Runtime capability — the ONLY module outside
 * consumers import.
 *
 * Two genuinely different things live behind this door. The HOST answers "who
 * owns this machine's runtime, which epoch is active, what is honestly true
 * after a restart". RUNS answers "what is this Agent doing, who replaced it,
 * who supervises it, and what happened to the spawn that got interrupted".
 *
 * This module carries ONLY the names an outside consumer (packages/server, and
 * this package's own contract tests) actually imports. Everything else is
 * imported from the module that owns it: contract/types.ts, contract/runs.ts,
 * contract/runs-api.ts, contract/ports.ts, core/ and adapters/.
 */

// ── Runtime host: lease, epoch fence, boot recovery ─────────────────────────

/** What the host reports: active epoch, live counts, and whether THIS process may mutate. */
export type { RuntimeStatus } from './types.js';

/** What a requested runtime stop did: what it stopped, what it refused, and whether it stopped. */
export type { RuntimeStopOutcome } from './types.js';

/** The host surface a process drives: ensure, stop, status, doctor, the epoch fence, shutdown. */
export type { RuntimeHostContract } from './types.js';

/** What one owned capability is responsible for right now, counted from durable records. */
export type { RuntimeCensus } from './types.js';

/** The OS single-instance lease the host holds so one machine has one runtime. */
export type { InstanceLease } from './types.js';

/** A capability the host reconciles after a restart without learning how it stores anything. */
export type { RecoverableCapability } from './types.js';

/** Production composition of the runtime host: lease, epoch store, recovery, stop. */
export { composeRuntimeHost } from '../core/compose.js';

/** The production InstanceLease: a lock file that can only be stolen from a dead process. */
export { createFileInstanceLease } from '../adapters/file-lease.js';

/** Boundary reader for a runtime-stop request; a stop is aimed at an epoch id, never a bare string. */
export { readRequestRuntimeStopInput } from './validate.js';

// ── Agent runs: spawn, continue, supervise, observe ─────────────────────────

/** The Runs surface a host drives: spawn/continue/stop/adopt, turn fencing, events, recovery. */
export type { AgentRunsContract } from './runs-api.js';

/** One Run as a caller reads it: identity, provider, launch origin, live attachments, family, usage. */
export type { AgentRunView } from './runs-api.js';

/** A family subtree of Runs, with the edges and each node's distance from the root. */
export type { AgentRunTreeView } from './runs-api.js';

/** One recoverable operation journal, with the per-Agent outcomes of a tree stop. */
export type { RunOperationView } from './runs-api.js';

/** One committed fact on the shared run event stream; the envelope names its owning capability. */
export type { RunEvent } from './runs-api.js';

/** A bounded page of the event stream plus the cursor that continues it exactly. */
export type { RunEventPage } from './runs-api.js';

/** The token `stopAgentTree` demands, minted over exactly the tree the caller was shown. */
export type { StopTreeConfirmation } from './runs-api.js';

/** Who looks after an Agent today — movable by adoption, unlike immutable spawn parentage. */
export type { SupervisionAssignment } from './runs.js';

/** The fence that freezes a subtree while a stop-tree walks it. */
export type { TreeMutationFence } from './runs.js';

/** Production composition of Agent Runs: stores, ports and providers wired into one contract. */
export {
  composeAgentRuns, type ComposedAgentRuns,
} from '../core/runs-compose.js';

// ── Boundary validation: every wire payload is read, never cast ─────────────

export { readSpawnAgentInput } from './runs-validate.js';
export { readContinueAgentInput } from './runs-validate.js';
export { readStopAgentInput } from './runs-validate.js';
export { readPrepareStopAgentTreeInput } from './runs-validate.js';
export { readStopAgentTreeInput } from './runs-validate.js';
export { readAdoptAgentInput } from './runs-validate.js';
export { readApplyRunControlInput } from './runs-validate.js';
export { readDiscoverRunControlsInput } from './runs-validate.js';
export { readInterruptAgentTurnInput } from './runs-validate.js';
export { readListAgentRunsFilter } from './runs-validate.js';
export { readGetAgentRunTreeInput } from './runs-validate.js';
export { readAgentRunIdInput } from './runs-validate.js';
export { readRunOperationIdInput } from './runs-validate.js';
export { readProviderTurnIdInput } from './runs-validate.js';
export { readCompleteProviderTurnInput } from './runs-validate.js';
export { readCloseProviderTurnCompletionUnprovenInput } from './runs-validate.js';
export { readControllerProviderTurnSubmitInput } from './runs-validate.js';
export { readProviderTurnSubmissionFilter } from './runs-validate.js';

// ── Ports the composition root must supply ──────────────────────────────────

/** Exactly what the Runtime asks of Agents: authority, launch plans, controls. Never role writes. */
export type { AgentsPort } from './ports.js';

/** Terminal through the one hole the Runtime needs: managed PTYs, typed input, turn barriers. */
export type { TerminalPort } from './ports.js';

/** Providers as three questions: what to launch, what it turned out to be, how to type at it. */
export type { ProviderPort } from './provider-ports.js';

/** How a spawned Agent authenticates as itself from inside its own PTY. */
export type { RunCredentialPort } from './ports.js';

/** Transcript-first bootstrap for a headless child: prepare a conversation, dispatch its brief. */
export type { HeadlessChildMessagingPort } from './custody-ports.js';

/** What Supervision must answer when a spawn installs the watchers its plan pinned. */
export type { RunWatcherPort } from './custody-ports.js';

/** The narrow Supervision seam for notification delivery: authority, claim, record. */
export type { NotificationDeliveryPort } from './notification-delivery.js';

// ── Facts that cross the seams ──────────────────────────────────────────────

/** The three honest answers to changing a control on a live Run: applied, needs replacement, unsupported. */
export type { AgentControlOutcomeFacts } from './controls.js';

/** What a provider can actually change on a live Run, and how honestly. */
export type { ControlCapabilityFacts } from './controls.js';

/** One terminal input attempt for a provider turn, with its barrier and effect state. */
export type { ProviderTurnInputAttemptFacts } from './ports.js';

/** One write in a turn's delivery and the beat before the next; delivery is never one write. */
export type { TurnDeliveryStep } from './types.js';

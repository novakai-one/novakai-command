/* eslint-disable id-length -- `run` is frozen contract text (FZ-VIEW-002). Renaming a
   field on its way to the browser is precisely the drift this file exists to stop. */
// shell/contract/agentRuns.ts — the Shell's read door onto Agent Runs
// (FZ-VIEW-001, P2 §12.6:2495–2536).
//
// The browser gets plain data through this facade and imports no capability
// implementation. That rule is why the types below are a browser-safe COPY of
// Agent Runtime's `AgentRunView` rather than an import of it.
//
// A copy is a second place truth can live, so this one is copied under two
// rules, both enforced by tests rather than by discipline:
//
//   1. FIELD NAMES ARE VERBATIM. Nothing is renamed, flattened, defaulted or
//      dropped on the way to the browser. `run.id` stays `run.id`. The Shell
//      renders the frozen projection; it does not own a projection of its own
//      (CL-S: a consumer that needs another field stops and reports).
//   2. LEAVES THAT ARE UNIONS UPSTREAM ARE `string` HERE. Re-typing
//      `AgentRunLifecycle`'s eight members in the browser would be a second
//      copy of a closed union, and a stale copy of a closed union is how a
//      host starts rendering a state it thinks is impossible. The Shell shows
//      these as text; it never decides what the set of legal values is.
//
// `AGENT_RUN_VIEW_SHAPE` below is the machine-readable form of rule 1, checked
// against a REAL view produced by the real Runtime in
// `packages/server/tests/b3e-tracer-consistency.test.ts`.

/** One sourced Supervision measurement, verbatim (P2 §9.1:1420). */
export interface RunUsageValue {
  readonly quality: string;
  readonly value?: number;
  readonly source: string;
  readonly limitations: readonly string[];
}

/** Supervision's per-Run projection, verbatim (FZ-VIEW-009). */
export interface RunUsageView {
  readonly agentRunId: string;
  readonly inputTokens: RunUsageValue;
  readonly outputTokens: RunUsageValue;
  readonly cachedInputTokens: RunUsageValue;
  readonly costMicros: RunUsageValue;
  readonly providerTurns: RunUsageValue;
  readonly observedAt: string;
  readonly final: boolean;
}

/** Who looks after this Agent today (P2 §6.2:124). Never who spawned it. */
export type RunSupervisorView =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'human'; readonly principalId: string }
  | { readonly kind: 'orphaned'; readonly reason: string };

/** The `agentRun` record as the browser receives it (FZ-VIEW-005). */
export interface AgentRunRecordView {
  readonly id: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly recordVersion: number;
  readonly createdAt: string;
  readonly permissionLevel: string;
  readonly createdBy: string;
  readonly lastMutation: unknown;
  readonly agentId: string;
  readonly launchPlanId: string;
  readonly providerSessionId: string;
  readonly terminalSessionId?: string;
  readonly lifecycle: string;
  readonly activity: string;
  readonly activityGeneration: number;
  readonly activeProviderTurn?: unknown;
  readonly providerTurnOperationFence?: unknown;
  readonly lastCompletedProviderTurn?: unknown;
  readonly launchSurface: string;
  readonly requestedBy: string;
  readonly parentRequestingRunId?: string;
  readonly rootTraceId: string;
  readonly startedAt?: string;
  readonly finalAt?: string;
  readonly finalReason?: string;
  readonly uncertainty: readonly string[];
}

/**
 * FZ-VIEW-002. What Chris reads about one Run.
 *
 * `launch` and the live facts are separate members on purpose: "no controller
 * attached" is not "stopped", and launch origin is historical truth that is
 * never inferred from who is attached now (FZ-VIEW-004, red gate 4).
 */
export interface AgentRunRowView {
  readonly agent: {
    readonly agentId: string;
    readonly displayName: string;
    readonly roleProfileId: string;
  };
  readonly run: AgentRunRecordView;
  readonly provider: {
    readonly provider: string;
    readonly modelId: string;
    readonly effort: string;
    readonly providerSessionId: string;
  };
  readonly launch: {
    readonly surface: string;
    readonly requestedBy: string;
    readonly startedAt?: string;
  };
  /**
   * §19.1 / FZ-VIEW-002, mirrored. Who is watching RIGHT NOW — a different
   * fact from `launch` (where it was started) and from `run.lifecycle`
   * (whether it is going). §24.5 red-gates all three against each other:
   * "'No controller' is not 'Agent stopped'".
   */
  readonly controllers: {
    readonly attachedCount: number;
    readonly kinds: readonly string[];
    readonly inputLeaseHolder?: string;
  };
  readonly family: {
    readonly parentAgentId?: string;
    readonly childCount: number;
    readonly supervisor: RunSupervisorView;
    readonly supervisionVersion: number;
  };
  readonly usage: RunUsageView;
  readonly transcript: {
    readonly bindingState: string;
    readonly mirrorWatermark?: string;
  };
}

/** `Page<T>`, verbatim (FZ-CLI-SCHEMA-010). The Shell never re-pages. */
export interface AgentRunsPageView {
  readonly items: readonly AgentRunRowView[];
  readonly nextCursor?: string;
  readonly omissions: readonly {
    readonly reason: string;
    readonly count: number;
  }[];
}

/** Domain failure is a value here too (FZ-CLI-SCHEMA-011). */
export type ShellReadResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/**
 * The one filter FZ-CLI-011 publishes. `state` means the same thing here as it
 * means to `nvk agent list --state` because both are handed to the same list
 * method unchanged — OQ-07's "two lanes disagree about what live means" is
 * closed by having no second interpretation to disagree with.
 *
 * `limit` and `cursor` are AMD-005 A5-01, passed through untouched.
 */
export interface ListAgentRunsRequest {
  readonly state?: 'live' | 'final' | 'all';
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * FZ-VIEW-001's read slice. B3e's tracer ships the Runs read; the lifecycle,
 * terminal, communications and supervision members of the frozen facade are
 * named there and arrive with their lanes.
 */
export interface ShellAgentServices {
  readonly runs: {
    listAgentRuns(request: ListAgentRunsRequest): Promise<ShellReadResult<AgentRunsPageView>>;
  };
}

/**
 * Rule 1, machine-readable: every field name the frozen projection carries, at
 * every level the Shell reaches into. A real view from the real Runtime is
 * checked against this, so a capability that ADDS a field and a Shell that
 * INVENTS one both fail loudly instead of drifting quietly.
 *
 * Optional members are listed too — a `Page` of Runs where none happens to
 * carry `startedAt` must not silently retire the field, so the check is
 * "no key outside this set", plus the required keys being present.
 */
export const AGENT_RUN_VIEW_SHAPE: Readonly<Record<string, readonly string[]>> = {
  '': ['agent', 'run', 'provider', 'launch', 'controllers', 'family', 'usage', 'transcript'],
  agent: ['agentId', 'displayName', 'roleProfileId'],
  provider: ['provider', 'modelId', 'effort', 'providerSessionId'],
  launch: ['surface', 'requestedBy', 'startedAt'],
  controllers: ['attachedCount', 'kinds', 'inputLeaseHolder'],
  family: ['parentAgentId', 'childCount', 'supervisor', 'supervisionVersion'],
  transcript: ['bindingState', 'mirrorWatermark'],
  usage: [
    'agentRunId', 'inputTokens', 'outputTokens', 'cachedInputTokens',
    'costMicros', 'providerTurns', 'observedAt', 'final',
  ],
  run: [
    'id', 'kind', 'schemaVersion', 'recordVersion', 'createdAt', 'permissionLevel',
    'createdBy', 'lastMutation', 'agentId', 'launchPlanId', 'providerSessionId',
    'terminalSessionId', 'lifecycle', 'activity', 'activityGeneration',
    'activeProviderTurn', 'providerTurnOperationFence', 'lastCompletedProviderTurn',
    'launchSurface', 'requestedBy', 'parentRequestingRunId', 'rootTraceId',
    'startedAt', 'finalAt', 'finalReason', 'uncertainty',
  ],
} as const;

// ── Presentation (DOM-free, so the rules are testable without a screen) ──────

/**
 * FZ-VIEW-004. Where the Run was STARTED — historical truth, read from
 * `launch.surface` and from nothing else. It is never inferred from who is
 * attached now, because "nobody is watching" and "started elsewhere" and
 * "stopped" are three different facts and the shell has told Chris the wrong
 * one before.
 */
const SURFACE_WORDS: Readonly<Record<string, string>> = {
  'novakai-shell': 'Novakai',
  'external-terminal': 'Terminal.app',
  agent: 'another Agent',
  script: 'a script',
  operations: 'Operations',
};

export function describeLaunchOrigin(view: AgentRunRowView): string {
  return `Started from ${SURFACE_WORDS[view.launch.surface] ?? view.launch.surface}`;
}

/**
 * FZ-VIEW-006. Two unions, two facts, drawn as two facts. `activity:"unknown"`
 * is legal and displayable — an honest "we do not know what it is doing right
 * now" is never rounded down to "stopped".
 */
export function describeRunState(view: AgentRunRowView): string {
  return `${view.run.lifecycle} · ${view.run.activity}`;
}

/** A measurement we do not have prints as a dash. A zero would be a claim. */
function describeValue(value: RunUsageValue, label: string): string {
  const amount = value.value === undefined ? '—' : value.value.toLocaleString('en-US');
  return `${amount} ${label} (${value.quality})`;
}

/**
 * FZ-VIEW-010. Every Run gets a usage line even when every value is missing,
 * and the QUALITY travels beside the number: "unavailable" is not zero, and a
 * measured 0 and an unmeasured nothing must never look the same.
 */
export function describeRunUsage(view: AgentRunRowView): string {
  return `${describeValue(view.usage.inputTokens, 'in')} · `
    + `${describeValue(view.usage.outputTokens, 'out')}`;
}

/**
 * Ordering is how this screen directs attention — the one mechanism Chris
 * accepts. It does not write "3 runs need you"; the rows that need him are
 * simply first: anything uncertain, then anything working, then the rest.
 */
export function orderRuns(items: readonly AgentRunRowView[]): AgentRunRowView[] {
  const rank = (view: AgentRunRowView): number => {
    if (view.run.uncertainty.length > 0) return 0;
    if (view.run.activity === 'working') return 1;
    if (view.run.activity === 'unknown') return 2;
    return 3;
  };
  return [...items].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    return String(right.run.createdAt).localeCompare(String(left.run.createdAt));
  });
}

/** Required at every level — absent means the projection lost a fact. */
export const AGENT_RUN_VIEW_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  '': ['agent', 'run', 'provider', 'launch', 'controllers', 'family', 'usage', 'transcript'],
  agent: ['agentId', 'displayName', 'roleProfileId'],
  provider: ['provider', 'modelId', 'effort', 'providerSessionId'],
  launch: ['surface', 'requestedBy'],
  controllers: ['attachedCount', 'kinds'],
  family: ['childCount', 'supervisor', 'supervisionVersion'],
  transcript: ['bindingState'],
  usage: [
    'agentRunId', 'inputTokens', 'outputTokens', 'cachedInputTokens',
    'costMicros', 'providerTurns', 'observedAt', 'final',
  ],
  run: [
    'id', 'kind', 'schemaVersion', 'recordVersion', 'createdAt', 'agentId',
    'launchPlanId', 'providerSessionId', 'lifecycle', 'activity',
    'activityGeneration', 'launchSurface', 'requestedBy', 'rootTraceId', 'uncertainty',
  ],
} as const;

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

import type {
  AgentCommunicationsPageView, ListAgentCommunicationsRequest,
} from './communications.js';
import type { ShellLifecycleServices, ShellRuntimeServices } from './agentLifecycle.js';
import type { ShellTerminalServices } from './agentTerminal.js';
import type { AgentRunTreeView, GetAgentRunTreeRequest } from './agentTree.js';
import type {
  ListNotificationsRequest, NotificationPageView, NotificationView,
} from './notificationRead.js';

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
 * FZ-VIEW-001's `communications` slice, read half. `sendAgentMessage` and
 * `openConversationView` are the other two members and arrive with the
 * compose-and-send path; this door is the one §19.2 inspection reads through.
 */
export interface ShellCommunicationServices {
  listAgentCommunications(
    request: ListAgentCommunicationsRequest,
  ): Promise<ShellReadResult<AgentCommunicationsPageView>>;
}

/**
 * FZ-VIEW-001's `supervision` slice, as far as the notification surface reaches.
 *
 * The read and the one mutation the frozen state machine actually accepts. Both
 * are published methods (`packages/server/core/runtime-host/supervision-methods.ts`); the
 * Shell had invented its own pair beside them and reached neither (L-14).
 * `subscribeNotifications` is the third member and is not wired here — the
 * screen re-reads through this door instead, so there is no second projection of
 * a Notification anywhere in the browser.
 *
 * B3.2 renamed `acknowledge` to the name the FREEZE gives it. The published wire
 * method is `b3.supervision.acknowledge` and stays that way; the short name came
 * first and scripts speak it. But a door member is contract, not transport, and
 * a second host written from P2 §12.6 reaches for `acknowledgeNotification` —
 * which until now was `undefined is not a function`. Same hazard the server
 * itself records for `b3.agent.controls` vs the spec's `getControls`.
 */
export interface ShellSupervisionServices {
  listNotifications(
    request: ListNotificationsRequest,
  ): Promise<ShellReadResult<NotificationPageView>>;
  acknowledgeNotification(notificationId: string): Promise<ShellReadResult<NotificationView>>;
}

/** `getAgentRun`'s request. One Run, named by id (FZ-VIEW-001's `runs` slice). */
export interface GetAgentRunRequest {
  readonly agentRunId: string;
}

/**
 * FZ-VIEW-001, whole.
 *
 * It was two thirds of a door until B3.2. The tracer shipped `runs` (minus
 * `getAgentRun`), B2.3 added `communications`, B2.5 added `supervision`, and
 * `runtime`, `lifecycle` and `terminal` were named in the freeze and built
 * nowhere — finding L-20. That was not a cosmetic gap: a frozen facade the host
 * implements two thirds of looks complete from inside the host, so each missing
 * slice surfaced as a STATED LIMIT on some screen ("this window cannot make that
 * lifecycle action yet") rather than as the hole it was. Two shipped that way.
 *
 * `SHELL_AGENT_SERVICES_SHAPE` below is the machine-readable form of the six
 * slices, and a test composes the real door and compares. A slice that goes
 * missing again fails a suite instead of becoming a sentence on a dialog.
 */
export interface ShellAgentServices {
  readonly runtime: ShellRuntimeServices;
  readonly runs: {
    getAgentRun(request: GetAgentRunRequest): Promise<ShellReadResult<AgentRunRowView>>;
    listAgentRuns(request: ListAgentRunsRequest): Promise<ShellReadResult<AgentRunsPageView>>;
    getAgentRunTree(request: GetAgentRunTreeRequest): Promise<ShellReadResult<AgentRunTreeView>>;
  };
  readonly lifecycle: ShellLifecycleServices;
  readonly terminal: ShellTerminalServices;
  readonly communications: ShellCommunicationServices;
  readonly supervision: ShellSupervisionServices;
}

/**
 * FZ-VIEW-001 as data: every slice, and every member of it, verbatim from
 * P2 §12.6:2495–2536 — including the members this host has not wired.
 *
 * Writing the WHOLE door down is the point. The version of this list that
 * contained only what the Shell happened to implement is what let three slices
 * go missing for seven seats: every screen could see a door it was fully using,
 * and the two thirds that did not exist showed up only as stated limits on
 * unrelated dialogs. A frozen contract is not a description of the host.
 */
export const SHELL_AGENT_SERVICES_FROZEN: Readonly<Record<string, readonly string[]>> = {
  runtime: ['getRuntimeStatus'],
  runs: ['getAgentRun', 'listAgentRuns', 'getAgentRunTree'],
  lifecycle: [
    'spawnAgent', 'interruptAgentTurn', 'stopAgent', 'prepareStopAgentTree',
    'stopAgentTree', 'continueAgent', 'adoptAgent',
  ],
  terminal: [
    'attachController', 'detachController', 'acquireInputLease', 'releaseInputLease',
    'writeInput', 'resizeTerminal', 'readTerminalStream',
  ],
  communications: ['sendAgentMessage', 'openConversationView', 'listAgentCommunications'],
  supervision: [
    'getRunUsage', 'getAgentUsage', 'listNotifications', 'acknowledgeNotification',
    'resetDriftEpisode',
  ],
} as const;

/**
 * The frozen members this host has NOT built, and the lane each belongs to.
 *
 * Named rather than omitted, so the gap is a fact with a home instead of a
 * silence. The suite asserts `wired ∪ unwired === frozen`, exactly: wiring a
 * member without striking it off here fails, and so does inventing one that the
 * freeze never named.
 *
 * `getRunUsage` / `getAgentUsage` are the interesting entry. The usage SCREENS
 * are built (B2.2) and read `usage` off the Run row the `runs` slice already
 * carries, which is the frozen projection's own copy — so the Shell is not
 * missing the numbers, it is missing Supervision's direct read of them. That
 * distinction is why this list carries a reason per member and not just a name.
 */
export const SHELL_AGENT_SERVICES_UNWIRED: Readonly<Record<string, string>> = {
  'communications.sendAgentMessage': 'compose-and-send; Messaging is the authority (FZ-VIEW-013)',
  'communications.openConversationView': 'compose-and-send lane',
  'supervision.getRunUsage': 'usage is read off the Run row the runs slice carries (B2.2)',
  'supervision.getAgentUsage': 'per-Agent totals; no surface reads them yet',
  'supervision.resetDriftEpisode': 'drift authoring; no Shell surface owns it',
} as const;

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
 * FZ-VIEW-003 must-show #2, and the one fact this projection cannot supply.
 *
 * The frozen `AgentRunView` (P2 §19.1) carries
 * `controllers{attachedCount, kinds, inputLeaseHolder?}`. The IMPLEMENTED view
 * in `packages/agent-runtime/contract/runs-api.ts` does not, and the frozen
 * Shell door (FZ-VIEW-001) offers no attachment query to fill the hole from —
 * its `terminal` slice is attach/detach/lease/write/resize/read, with no
 * `getTerminalSession` and no `listControllerAttachments`.
 *
 * So the Shell says so. CL-S forbids a lane from adding the field; drawing a
 * `0` would be worse than saying nothing, because `0 controllers` is a claim
 * Chris would read as "nobody is watching this" — one inference away from the
 * "no controller means stopped" mistake red gate 4 exists to stop.
 *
 * Reported to the orchestrator as T-06. When the ruling lands, this function
 * gets a projection to read and its test stops asserting the gap.
 */
export function describeControllers(_view: AgentRunRowView): string {
  return 'not carried by this projection';
}

/**
 * FZ-VIEW-003 must-show #3 — whether the background provider process is live.
 *
 * Keyed on `run.finalAt` and on nothing else. The OQ-07 ruling is explicit that
 * finality is NOT a function of the lifecycle enum ("`interrupted` is final
 * only after reconciliation confirms no live provider process") and that
 * `finalAt` is the single published observable. `nvk agent list --state` keys
 * on the same field, so the Shell and the CLI cannot disagree about who is
 * still running — FZ-VIEW-034 held by construction rather than by a promise.
 *
 * Note what this deliberately does NOT consult: controllers. Nobody attached is
 * not stopped.
 */
export function describeBackgroundProcess(view: AgentRunRowView): string {
  if (view.run.finalAt === undefined) return 'still running in the Novakai Runtime';
  const why = view.run.finalReason === undefined ? '' : ` · ${view.run.finalReason}`;
  return `ended ${readableUtc(view.run.finalAt)}${why}`;
}

/**
 * `2026-08-06T03:11:00.000Z` → `2026-08-06 03:11 UTC`.
 *
 * Presentation, not derivation: same instant, same zone, fewer characters
 * between Chris and the fact. An unparseable stamp is handed back untouched —
 * a projection that sends something unexpected gets SHOWN, never swallowed.
 */
function readableUtc(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

/** Who looks after this Agent today — never who spawned it (P2 §6.2). */
function describeSupervisor(supervisor: RunSupervisorView): string {
  if (supervisor.kind === 'human') return `supervised by ${supervisor.principalId}`;
  if (supervisor.kind === 'agent') return `supervised by ${supervisor.agentId}`;
  return `orphaned · ${supervisor.reason}`;
}

/**
 * FZ-VIEW-003 must-show #5 — parent and current supervisor.
 *
 * `family.childCount` is a measured number, so a `0` here is a fact and is
 * drawn as one. That is the opposite call from usage and controllers, and the
 * difference is the whole point: a zero the owner counted is truth, a zero the
 * consumer invented is a lie.
 */
export function describeFamily(view: AgentRunRowView): string {
  const parent = view.family.parentAgentId === undefined
    ? 'no parent'
    : `parent ${view.family.parentAgentId}`;
  const children = view.family.childCount === 0
    ? 'no children'
    : `${view.family.childCount} children`;
  return `${describeSupervisor(view.family.supervisor)} · ${parent} · ${children}`;
}

/** FZ-VIEW-003 must-show #7 — the recovery/uncertainty warnings, verbatim. */
export function describeWarnings(view: AgentRunRowView): string {
  return view.run.uncertainty.join(', ');
}

/**
 * One entry per line of P2 §19.1's "The view MUST show" list.
 *
 * The list is a manifest rather than seven remembered render calls because a
 * must-show list that lives only in a spec paragraph is a must-show list a
 * future seat drops one item from while every test stays green. `source` is
 * the honest part: `not-carried` names a fact the implemented projection
 * cannot supply, which the screen still draws — as the gap it is.
 */
export interface AgentRunMustShowFact {
  readonly id: string;
  /** What Chris reads as the label. Also how a test finds the fact on screen. */
  readonly term: string;
  readonly source: 'projection' | 'not-carried';
  /** Drawn only when this returns a non-empty string. */
  readonly describe: (view: AgentRunRowView) => string;
}

export const AGENT_RUN_MUST_SHOW: readonly AgentRunMustShowFact[] = [
  {
    id: 'launch-origin', term: 'Started from', source: 'projection',
    describe: (view) => `${describeLaunchOrigin(view)} · by ${view.launch.requestedBy}`,
  },
  {
    id: 'controllers', term: 'Controllers attached', source: 'not-carried',
    describe: describeControllers,
  },
  {
    id: 'background-process', term: 'Background process', source: 'projection',
    describe: describeBackgroundProcess,
  },
  {
    id: 'activity', term: 'Working or idle', source: 'projection',
    describe: (view) => view.run.activity,
  },
  {
    id: 'family', term: 'Family', source: 'projection',
    describe: describeFamily,
  },
  {
    id: 'usage', term: 'Usage', source: 'projection',
    describe: describeRunUsage,
  },
  {
    id: 'warnings', term: 'Warnings', source: 'projection',
    describe: describeWarnings,
  },
];

/** Lookup by id. Throws on an unknown id — a typo must not silently draw less. */
export function mustShowFact(id: string): AgentRunMustShowFact {
  const found = AGENT_RUN_MUST_SHOW.find((fact) => fact.id === id);
  if (found === undefined) throw new Error(`no must-show fact "${id}"`);
  return found;
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

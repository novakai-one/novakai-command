// What a Run looks like from outside.
//
// The view's job is to keep four facts apart that a careless UI collapses into
// one word: where a Run STARTED, who is attached NOW, whether the provider is
// live, and whether it is working. "No controller" is not "stopped"; "unknown"
// is not "zero".
import {
  b3err, b3fail, b3ok,
  type AgentId, type AgentRunId, type AuthenticatedPrincipal, type B3Page,
  type B3Result, type EventCursor, type IsoUtc, type ResolvedLaunchPlanId, type RunOperationId,
} from '@novakai/foundation/contract';
import type {
  AgentRunView, ListAgentRunsFilter, RunOperationView,
} from '../contract/runs-api.js';
import type { AgentRunUsage, UsageValue } from '../../supervision/contract/index.js';
import {
  FINAL_LIFECYCLES, type AgentRun, type RunOperation,
} from '../contract/runs.js';
import { assignmentChain, requireRun, type RunsCore } from './runs-context.js';
import { recoveryRequired, unknownRun } from './runs-store.js';
import { settleIfTerminalGone } from './recover.js';

/**
 * The view field is named `run`. LOAD-BEARING: it is a compatibility contract
 * — the CLI `--json` and the wire both carry it — so it is built through this
 * key rather than written as a bare literal.
 */
const RUN_FIELD = 'run';

function unavailableUsage(agentRun: AgentRun, observedAt: IsoUtc): AgentRunUsage {
  const unavailable = (): UsageValue => ({
    quality: 'unavailable',
    source: 'agent-runtime:usage-not-composed',
    limitations: ['usage-capability-not-composed'],
  });
  return {
    agentRunId: agentRun.id,
    inputTokens: unavailable(),
    outputTokens: unavailable(),
    cachedInputTokens: unavailable(),
    costMicros: unavailable(),
    providerTurns: unavailable(),
    observedAt,
    final: FINAL_LIFECYCLES.has(agentRun.lifecycle),
  };
}

/** No terminal session ⇒ no attachments to hang off one. Truth, not a default. */
const NO_CONTROLLERS: AgentRunView['controllers'] = { attachedCount: 0, kinds: [] };

/**
 * The controllers section of the view, from the one owner of
 * ControllerAttachment and TerminalInputLease. The Runtime asks Terminal every
 * read and caches nothing, and it never derives this from `launch.surface`.
 */
async function controllersOfRun(
  core: RunsCore, principal: AuthenticatedPrincipal, agentRun: AgentRun,
): Promise<B3Result<AgentRunView['controllers']>> {
  if (agentRun.terminalSessionId === undefined) return b3ok(NO_CONTROLLERS);
  return core.terminal.controllerFacts(principal, agentRun.terminalSessionId);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- View projection retains explicit custody states.
export async function viewOfRun(
  core: RunsCore, principal: AuthenticatedPrincipal, stale: AgentRun,
): Promise<B3Result<AgentRunView>> {
  const reconciled = await settleIfTerminalGone(core, stale);
  if (!reconciled.ok) return reconciled;
  const agentRun = reconciled.value;
  const agent = await core.agents.getAgent(principal, agentRun.agentId);
  if (!agent.ok) return agent;
  const plan = await core.agents.getLaunchPlan(principal, agentRun.launchPlanId);
  if (!plan.ok) return plan;
  const children = await core.agents.listChildRelationships(principal, agentRun.agentId);
  if (!children.ok) return children;
  const supervision = await assignmentChain(core, agentRun.agentId);
  if (!supervision.ok) return supervision;
  // Parentage is asked for, never cached: Agents owns it.
  const parent = await core.agents.parentAgentIdOf(principal, agentRun.agentId);
  if (!parent.ok) return parent;
  // Transcript owns this fact; the Runtime asks. A null answer is "no binding",
  // never "no transcript" — the two are told apart in the view below.
  const binding = (await core.transcriptBinding?.(agentRun.id)) ?? null;
  // The controllers section, asked of Terminal on every read and never
  // cached. A Run with no terminal session has no attachments to hang
  // off one, so `{0, []}` there is truth rather than a fallback —
  // and when Terminal cannot answer, the read FAILS below rather than
  // fabricating a zero ("unavailable" is not zero).
  const controllers = await controllersOfRun(core, principal, agentRun);
  if (!controllers.ok) return controllers;
  const usage = core.usage === undefined
    ? b3ok(unavailableUsage(agentRun, new Date(core.clock()).toISOString() as IsoUtc))
    : await core.usage(principal, agentRun.id);
  if (!usage.ok) return usage;

  return b3ok({
    agent: {
      agentId: agent.value.id,
      displayName: agent.value.displayName,
      roleProfileId: agent.value.roleProfileId,
    },
    provider: {
      provider: plan.value.provider,
      modelId: plan.value.modelId,
      effort: plan.value.effort,
      providerSessionId: agentRun.providerSessionId,
    },
    launch: {
      surface: agentRun.launchSurface,
      requestedBy: agentRun.requestedBy,
      ...(agentRun.startedAt === undefined ? {} : { startedAt: agentRun.startedAt }),
    },
    controllers: controllers.value,
    family: {
      ...(parent.value === null ? {} : { parentAgentId: parent.value }),
      childCount: children.value.length,
      supervisor: supervision.value.current?.supervisor
        ?? { kind: 'orphaned', reason: 'no supervision assignment has been recorded' },
      // The CAS token an adoption has to quote. Without it here, the only way
      // to obtain it is to guess — and a compare-and-set nobody can read the
      // "expected" side of is not a safety mechanism, it is a retry loop.
      supervisionVersion: supervision.value.generation,
    },
    usage: usage.value,
    // Where this Run's transcript is, in the same four words Transcript
    // uses. `unbound` is the fifth: nobody has bound this Run at all, which is
    // a different fact from a file that is missing.
    transcript: binding === null
      ? { bindingState: 'unbound' as const }
      : {
          bindingState: binding.bindingState,
          ...(binding.mirrorWatermark === undefined
            ? {} : { mirrorWatermark: binding.mirrorWatermark }),
        },
    [RUN_FIELD]: agentRun,
  } as AgentRunView);
}

export async function getAgentRun(
  core: RunsCore, principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
): Promise<B3Result<AgentRunView>> {
  const agentRun = await requireRun(core, agentRunId);
  if (!agentRun.ok) return agentRun;
  return viewOfRun(core, principal, agentRun.value);
}

const RUN_CURSOR_PREFIX = 'agentRuns.';

interface RunCursorPosition { readonly createdAt: string; readonly id: string }

/**
 * The opaque keyset position for this listing, over the stable
 * `(createdAt,id)` order every list method pages by. Minted here
 * and read here, because a cursor belongs to the stream owner that made it —
 * the prefix is what lets a cursor from another listing be
 * refused rather than silently misread as a position in this one.
 */
function runCursorFor(agentRun: AgentRun): EventCursor {
  const encoded = Buffer.from(JSON.stringify([agentRun.createdAt, String(agentRun.id)]), 'utf8')
    .toString('base64url');
  return `${RUN_CURSOR_PREFIX}${encoded}` as EventCursor;
}

function readRunCursor(cursor: EventCursor): B3Result<RunCursorPosition> {
  try {
    if (!String(cursor).startsWith(RUN_CURSOR_PREFIX)) throw new Error('wrong prefix');
    const decoded = JSON.parse(Buffer.from(
      String(cursor).slice(RUN_CURSOR_PREFIX.length), 'base64url',
    ).toString('utf8')) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2
      || typeof decoded[0] !== 'string' || typeof decoded[1] !== 'string') {
      throw new Error('wrong tuple');
    }
    return b3ok({ createdAt: decoded[0], id: decoded[1] });
  } catch {
    return b3fail(b3err('ValidationFailed', 'run cursor is not an Agent Runtime continuation',
      { issues: [{ path: 'cursor', message: 'is malformed or belongs to another query' }] },
      false));
  }
}

const afterRunCursor = (agentRun: AgentRun, from: RunCursorPosition): boolean =>
  agentRun.createdAt > from.createdAt
  || (agentRun.createdAt === from.createdAt && String(agentRun.id) > from.id);

function matchesRunFilter(agentRun: AgentRun, filter: ListAgentRunsFilter): boolean {
  if (!filter.includeFinal && FINAL_LIFECYCLES.has(agentRun.lifecycle)) return false;
  // `finalAt` is the owner's decision made observable; asking whether
  // the lifecycle LOOKS final would be the consumer deriving finality, which
  // is forbidden.
  if (filter.onlyFinal === true && agentRun.finalAt === undefined) return false;
  if (filter.lifecycle && !filter.lifecycle.includes(agentRun.lifecycle)) return false;
  return filter.launchSurface === undefined || agentRun.launchSurface === filter.launchSurface;
}

/**
 * The attachment filter, applied conjunctively with the record-only
 * members above.
 *
 * It runs BEFORE the page is cut, never after: filtering a already-sliced page
 * would hand the caller fewer items than it asked for while `nextCursor`
 * claimed a full window — silent truncation. The Terminal read is paid only
 * when the caller actually states the filter.
 */
async function matchesControllerState(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  agentRun: AgentRun,
  wanted: NonNullable<ListAgentRunsFilter['controllerState']>,
): Promise<B3Result<boolean>> {
  const controllers = await controllersOfRun(core, principal, agentRun);
  if (!controllers.ok) return controllers;
  // The ruled equivalence, spelled once: "attached" ⇔ attachedCount > 0, and
  // "headless" is its exact complement. Never read off `launch.surface`.
  const attached = controllers.value.attachedCount > 0;
  return b3ok(wanted === 'attached' ? attached : !attached);
}

async function narrowByControllerState(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  candidates: readonly AgentRun[],
  filter: ListAgentRunsFilter,
): Promise<B3Result<readonly AgentRun[]>> {
  if (filter.controllerState === undefined) return b3ok(candidates);
  const kept: AgentRun[] = [];
  for (const agentRun of candidates) {
    const matches = await matchesControllerState(core, principal, agentRun, filter.controllerState);
    if (!matches.ok) return matches;
    if (matches.value) kept.push(agentRun);
  }
  return b3ok(kept);
}

/**
 * The page of Runs a filter selects: ordered by the stable `(createdAt,id)`
 * key, resumed after the caller's cursor, filtered, then cut to `limit`.
 *
 * Separate from the projection below because they answer different questions —
 * WHICH records this page is, and what each of them looks like to this reader.
 */
async function runPageWindow(
  core: RunsCore,
  principal: AuthenticatedPrincipal,
  stored: readonly AgentRun[],
  filter: ListAgentRunsFilter,
): Promise<B3Result<{ readonly wanted: readonly AgentRun[]; readonly more: boolean }>> {
  const position = filter.cursor === undefined ? b3ok(null) : readRunCursor(filter.cursor);
  if (!position.ok) return position;
  const ordered = [...stored].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id)));
  const from = position.value;
  const byRecord = ordered
    .filter((agentRun) => from === null || afterRunCursor(agentRun, from))
    .filter((agentRun) => matchesRunFilter(agentRun, filter));
  const narrowed = await narrowByControllerState(core, principal, byRecord, filter);
  if (!narrowed.ok) return narrowed;
  const matching = narrowed.value;
  // No owner-side default: `limit` is required and the one default
  // is the CLI's 200. `?? 500` was a second authority
  // answering "how big is a page".
  const wanted = matching.slice(0, filter.limit);
  return b3ok({ wanted, more: wanted.length < matching.length });
}

export async function listAgentRuns(
  core: RunsCore, principal: AuthenticatedPrincipal, filter: ListAgentRunsFilter,
): Promise<B3Result<B3Page<AgentRunView>>> {
  const runs = await core.store.list<AgentRun>(
    'agentRun', filter.agentId === undefined ? undefined : { agentId: filter.agentId },
  );
  if (!runs.ok) return runs;
  const page = await runPageWindow(core, principal, runs.value, filter);
  if (!page.ok) return page;
  const { wanted, more } = page.value;

  const items: AgentRunView[] = [];
  let omitted = 0;
  for (const agentRun of wanted) {
    const view = await viewOfRun(core, principal, agentRun);
    // A Run whose Agent this reader cannot resolve is COUNTED, never dropped —
    // a Run is not hidden for lacking something.
    if (!view.ok) {
      omitted += 1;
      continue;
    }
    items.push(view.value);
  }
  // Minted from the last record in the PAGE WINDOW, not the last visible item:
  // a Run counted into `omissions` still occupied a place in the order, and
  // resuming after the last item would hand it out again on the next page.
  const nextCursor = more ? runCursorFor(wanted.at(-1)!) : undefined;
  return b3ok({
    items,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    omissions: omitted === 0 ? [] : [{ reason: 'permission', count: omitted }],
  });
}

/** Every Run this Agent has ever had, viewed. Shared with the tree walk. */
export async function runsOfAgent(
  core: RunsCore, principal: AuthenticatedPrincipal, agentId: AgentId,
): Promise<B3Result<readonly AgentRunView[]>> {
  const runs = await core.store.list<AgentRun>('agentRun', { agentId });
  if (!runs.ok) return runs;
  const views: AgentRunView[] = [];
  for (const agentRun of runs.value) {
    const view = await viewOfRun(core, principal, agentRun);
    if (view.ok) views.push(view.value);
  }
  return b3ok(views);
}

export async function getRunOperation(
  core: RunsCore, _principal: AuthenticatedPrincipal, operationId: RunOperationId,
): Promise<B3Result<RunOperationView>> {
  const found = await core.store.read<RunOperation>('runOperation', operationId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(recoveryRequired(operationId, 'unknown', 'no such operation'));
  }
  return b3ok({ operation: found.value, perAgentOutcomes: found.value.perAgentOutcomes ?? [] });
}

export async function listRunOperations(
  core: RunsCore,
  _principal: AuthenticatedPrincipal,
  filter?: { readonly includeCompleted?: boolean },
): Promise<B3Result<readonly RunOperationView[]>> {
  const listed = await core.store.list<RunOperation>('runOperation');
  if (!listed.ok) return listed;
  const wanted = filter?.includeCompleted === true
    ? listed.value : listed.value.filter((operation) => operation.state !== 'completed');
  return b3ok(wanted.map((operation) => ({
    operation, perAgentOutcomes: operation.perAgentOutcomes ?? [],
  })));
}

export async function getRunLaunchPlanId(
  core: RunsCore, _principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
): Promise<B3Result<ResolvedLaunchPlanId>> {
  const agentRun = await core.store.read<AgentRun>('agentRun', agentRunId);
  if (!agentRun.ok) return agentRun;
  if (agentRun.value === null) return b3fail(unknownRun(agentRunId));
  return b3ok(agentRun.value.launchPlanId);
}

/**
 * What this Runtime is currently responsible for, in Run terms. Counted from
 * the durable records rather than from memory, so a restarted Runtime reports
 * what is on disk instead of what it happens to remember.
 */
export async function runsCensus(
  core: RunsCore,
): Promise<B3Result<{
  readonly liveAgentRunCount: number;
  readonly recoveryRequiredCount: number;
  readonly recoveryRequiredRefs: readonly string[];
}>> {
  const runs = await core.store.list<AgentRun>('agentRun');
  if (!runs.ok) return runs;
  const operations = await core.store.list<RunOperation>('runOperation');
  if (!operations.ok) return operations;
  const needing = [
    ...runs.value.filter((item) => item.lifecycle === 'recovery-required').map((item) => item.id),
    ...operations.value
      .filter((item) => item.state === 'recovery-required').map((item) => item.id),
  ];
  return b3ok({
    liveAgentRunCount: runs.value.filter(
      (item) => !FINAL_LIFECYCLES.has(item.lifecycle),
    ).length,
    recoveryRequiredCount: needing.length,
    recoveryRequiredRefs: needing,
  });
}

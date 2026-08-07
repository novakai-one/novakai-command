/* eslint-disable id-length -- `ok` is the frozen result field every B3 caller
   reads (FZ-CLI-SCHEMA-001/011). Spelling it anything else here would mean this
   door no longer speaks the contract it exists to pass through. */
// shell/app/agentRuns.ts — the implementation behind FZ-VIEW-001's Runs read.
//
// It does exactly two things: translate the published request into the
// published filter, and hand the answer back untouched. Everything it is
// TEMPTED to do — rename a field to something the screen finds convenient,
// default an absent number to zero, sort the page, decide which Runs count as
// live — belongs to the capability that owns the fact (CL-O), and every one of
// those temptations is a way for the Shell to contradict the CLI about the
// same Run (FZ-VIEW-034).
//
// No browser API is used here on purpose: the transport arrives as a function,
// so the same door a browser drives is the door a Node test drives, and the
// cross-host proof in `packages/server/tests/b3e-tracer-consistency.test.ts`
// exercises the real thing rather than a re-implementation of it.
import {
  AGENT_RUN_VIEW_REQUIRED, AGENT_RUN_VIEW_SHAPE,
  type AgentRunRowView, type AgentRunsPageView, type ListAgentRunsRequest,
  type ShellAgentServices, type ShellReadResult,
} from '../contract/agentRuns.js';
import type { AgentRunTreeView } from '../contract/agentTree.js';
import { createShellCommunicationServices } from './communications.js';
import { createShellSupervisionServices } from './supervision.js';
import { createShellLifecycleServices, createShellRuntimeServices } from './agentLifecycle.js';
import { createShellTerminalServices } from './agentTerminal.js';

/**
 * One nvk-ws v1 call, payload-level: the transport owns the `{contractVersion,
 * clientOpId, payload}` envelope and the frame, exactly as it does for every
 * other B3 method. There is no second dialect here (LAW 2).
 */
export type B3ReadCall = (method: string, payload: unknown) => Promise<unknown>;

export interface ShellAgentServicesOptions {
  readonly call: B3ReadCall;
}

/**
 * AMD-005 A5-01: `--limit` is 1–200 and the caller supplies 200 when it omits
 * one. The same number, for the same reason, on this side of the seam.
 */
const DEFAULT_LIMIT = 200;

/**
 * OQ-07's ruling, whole: `state` maps ONLY to `includeFinal` (+ `onlyFinal`),
 * and no consumer computes liveness. Finality is the owner's judgement — an
 * `interrupted` Run is final only once reconciliation confirms no live provider
 * process — so a host that filtered on the lifecycle enum would be inventing
 * an answer the owner never gave. That is the B3d SEVERE-2 shape exactly.
 */
export function listFilterForState(request: ListAgentRunsRequest): Record<string, unknown> {
  const state = request.state ?? 'live';
  return {
    includeFinal: state !== 'live',
    ...(state === 'final' ? { onlyFinal: true } : {}),
    limit: request.limit ?? DEFAULT_LIMIT,
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

/** Parse the wire answer from `unknown` at the seam; never trust its shape. */
function readPage(answer: unknown): ShellReadResult<AgentRunsPageView> {
  const frame = answer as {
    ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown };
  } | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('the Runtime returned no answer');
  }
  if (frame.ok !== true) {
    return refused(frame.error);
  }
  const page = frame.value as { items?: unknown; omissions?: unknown } | null;
  if (page === null || typeof page !== 'object'
    || !Array.isArray(page.items) || !Array.isArray(page.omissions)) {
    return unavailable('the Runtime returned something that is not a page of Runs');
  }
  // Verbatim. Not spread, not rebuilt, not sorted — the same object graph the
  // CLI prints, so "the same bytes" is a property of the code and not a
  // coincidence two tests happen to agree on.
  return { ok: true, value: page as unknown as AgentRunsPageView };
}

/**
 * Parse ONE Run row. The check is `run.id`, because that is the fact the caller
 * asked about and the one a stop is aimed at — an answer with no `run.id` is not
 * a Run row, and handing it on would put an undefined into a `StopAgentInput`.
 */
function readRow(answer: unknown): ShellReadResult<AgentRunRowView> {
  const frame = answer as {
    ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown };
  } | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('the Runtime returned no answer');
  }
  if (frame.ok !== true) return refused(frame.error);
  const row = frame.value as { run?: { id?: unknown } } | null;
  if (row === null || typeof row !== 'object' || typeof row.run?.id !== 'string') {
    return unavailable('the Runtime returned something that is not a Run');
  }
  return { ok: true, value: row as unknown as AgentRunRowView };
}

/** Parse the tree answer from `unknown` at the seam; never trust its shape. */
function readTree(answer: unknown): ShellReadResult<AgentRunTreeView> {
  const frame = answer as {
    ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown };
  } | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('the Runtime returned no answer');
  }
  if (frame.ok !== true) return refused(frame.error);
  const tree = frame.value as { nodes?: unknown; edges?: unknown } | null;
  if (tree === null || typeof tree !== 'object'
    || !Array.isArray(tree.nodes) || !Array.isArray(tree.edges)) {
    return unavailable('the Runtime returned something that is not an Agent family');
  }
  return { ok: true, value: tree as unknown as AgentRunTreeView };
}

function refused(
  error: { code?: unknown; message?: unknown } | undefined,
): ShellReadResult<never> {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'RuntimeUnavailable',
      message: typeof error?.message === 'string'
        ? error.message : 'the Runtime refused the request',
    },
  };
}

function unavailable(message: string): ShellReadResult<never> {
  return { ok: false, error: { code: 'RuntimeUnavailable', message } };
}

/** `''` names the top level; anything else names a nested member. */
function labelFor(level: string): string {
  return level === '' ? '<view>' : level;
}

/** Fields the projection sent that this copy of the contract has never heard of. */
function unknownFields(
  present: readonly string[], allowed: readonly string[], level: string,
): string[] {
  return present.filter((field) => !allowed.includes(field))
    .map((field) => `${labelFor(level)}.${field} is not in the frozen projection`);
}

/** Facts the copy requires that did not arrive. */
function missingFields(present: readonly string[], level: string): string[] {
  return (AGENT_RUN_VIEW_REQUIRED[level] ?? [])
    .filter((field) => !present.includes(field))
    .map((field) => `${labelFor(level)}.${field} is missing from the projection`);
}

function driftAt(node: unknown, level: string): string[] {
  const allowed = AGENT_RUN_VIEW_SHAPE[level];
  if (allowed === undefined) return [];
  if (node === null || typeof node !== 'object') {
    return [`${labelFor(level)} is not an object`];
  }
  const present = Object.keys(node as Record<string, unknown>);
  return [...unknownFields(present, allowed, level), ...missingFields(present, level)];
}

/**
 * The drift guard for the browser-safe copy, expressed as data.
 *
 * Run over a REAL view from the real Runtime it answers the only question that
 * matters about a copied contract: are these still the same fields? It reports
 * in both directions — a field the projection carries that the Shell has never
 * heard of, and a required fact that went missing on the way through.
 *
 * Nested levels are visited only where `AGENT_RUN_VIEW_SHAPE` names them, so an
 * opaque member like `run.lastMutation` stays opaque: the Shell displays it
 * nowhere and therefore has no business asserting its shape.
 */
export function agentRunViewDrift(view: unknown): readonly string[] {
  const problems = driftAt(view, '');
  if (view === null || typeof view !== 'object') return problems;
  for (const field of Object.keys(view as Record<string, unknown>)) {
    if (AGENT_RUN_VIEW_SHAPE[field] !== undefined) {
      problems.push(...driftAt((view as Record<string, unknown>)[field], field));
    }
  }
  return problems;
}

export function createShellAgentServices(
  options: ShellAgentServicesOptions,
): ShellAgentServices {
  return {
    // FZ-VIEW-001 is ONE facade, and after B3.2 it is the WHOLE facade. Every
    // slice is built here rather than beside its screen, so a surface cannot
    // acquire half a door — and cannot quietly do without a slice, which is how
    // `lifecycle` stayed unbuilt while two dialogs explained its absence.
    runtime: createShellRuntimeServices(options.call),
    lifecycle: createShellLifecycleServices(options.call),
    terminal: createShellTerminalServices(options.call),
    communications: createShellCommunicationServices(options),
    supervision: createShellSupervisionServices(options),
    runs: {
      /**
       * One Run, by id. The terminal tab's route into a stop: a tab carries an
       * `agentRunId` on `owner.label` and nothing else, and `StopAgentInput`
       * wants the `agentId` too — so this read is the only honest source of it
       * (contract/agentLifecycle.ts, rule 3).
       */
      async getAgentRun(request) {
        try {
          return readRow(await options.call('b3.agent.getRun', {
            agentRunId: request.agentRunId,
          }));
        } catch (cause) {
          return unavailable(cause instanceof Error ? cause.message : String(cause));
        }
      },
      /**
       * The family. `maxDepth` is passed only when the caller named one — a
       * default invented here would silently truncate a tree the owner was
       * willing to draw whole, and the answer carries no marker to say so
       * (the AMD-005 residual; see contract/agentTree.ts).
       */
      async getAgentRunTree(request) {
        try {
          return readTree(await options.call('b3.agent.getTree', {
            rootAgentId: request.rootAgentId,
            ...(request.maxDepth === undefined ? {} : { maxDepth: request.maxDepth }),
          }));
        } catch (cause) {
          return unavailable(cause instanceof Error ? cause.message : String(cause));
        }
      },
      async listAgentRuns(request) {
        try {
          return readPage(await options.call('b3.agent.listRuns', listFilterForState(request)));
        } catch (cause) {
          // A dead socket is a state the screen must be able to DRAW, not an
          // exception that blanks it (FZ-CLI-SCHEMA-011).
          return unavailable(cause instanceof Error ? cause.message : String(cause));
        }
      },
    },
  };
}

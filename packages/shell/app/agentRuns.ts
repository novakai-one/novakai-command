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
  type AgentRunsPageView, type ListAgentRunsRequest, type ShellAgentServices,
  type ShellReadResult,
} from '../contract/agentRuns.js';

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
    return {
      ok: false,
      error: {
        code: typeof frame.error?.code === 'string' ? frame.error.code : 'RuntimeUnavailable',
        message: typeof frame.error?.message === 'string'
          ? frame.error.message : 'the Runtime refused the request',
      },
    };
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

function unavailable(message: string): ShellReadResult<never> {
  return { ok: false, error: { code: 'RuntimeUnavailable', message } };
}

export function createShellAgentServices(
  options: ShellAgentServicesOptions,
): ShellAgentServices {
  return {
    runs: {
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

/**
 * The drift guard for the browser-safe copy, as data.
 *
 * A copy of a contract rots silently: the capability grows a field, the Shell
 * keeps rendering the six it knows, and nobody finds out until two screens
 * disagree. Running this over a REAL view from the REAL Runtime turns that
 * into a failing test the moment it happens.
 */
export function agentRunViewDrift(view: unknown): readonly string[] {
  const problems: string[] = [];
  const visit = (node: unknown, at: string): void => {
    const allowed = AGENT_RUN_VIEW_SHAPE[at];
    if (allowed === undefined) return;
    if (node === null || typeof node !== 'object') {
      problems.push(`${at || '<view>'} is not an object`);
      return;
    }
    const present = Object.keys(node as Record<string, unknown>);
    for (const key of present) {
      if (!allowed.includes(key)) {
        problems.push(`${at || '<view>'}.${key} is not in the frozen projection`);
      }
    }
    for (const key of AGENT_RUN_VIEW_REQUIRED[at] ?? []) {
      if (!present.includes(key)) {
        problems.push(`${at || '<view>'}.${key} is missing from the projection`);
      }
    }
    for (const key of present) {
      if (AGENT_RUN_VIEW_SHAPE[key] !== undefined && at === '') {
        visit((node as Record<string, unknown>)[key], key);
      }
    }
  };
  visit(view, '');
  return problems;
}

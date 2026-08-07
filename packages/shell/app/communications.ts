/* eslint-disable id-length -- `ok` is the frozen result field every B3 caller
   reads (FZ-CLI-SCHEMA-001/011); renaming it here would mean this door no
   longer speaks the contract it exists to pass through. */
// shell/app/communications.ts — the implementation behind FZ-VIEW-001's
// `communications` read (`listAgentCommunications`).
//
// Same two jobs as the Runs door: translate the published request into the
// published input, and hand the answer back untouched. It does not sort (the
// owner's order is what its cursor means), does not re-page, does not fill in
// an absent `screenContext` (FZ-VIEW-014 — and there is nothing here that
// could), and does not turn a transport failure into a blank screen.
import {
  COMMUNICATION_VIEW_EXTRAS, COMMUNICATION_VIEW_FROZEN,
  COMMUNICATION_VIEW_REQUIRED, SCREEN_CONTEXT_ECHO_FROZEN,
  type AgentCommunicationsPageView, type ListAgentCommunicationsRequest,
} from '../contract/communications.js';
import type { ShellCommunicationServices, ShellReadResult } from '../contract/agentRuns.js';
import type { B3ReadCall } from './agentRuns.js';

/** AMD-005 A5-01's ceiling, the same number the Runs door defaults to. */
const DEFAULT_LIMIT = 200;

/** The published input, built from the published request and nothing else. */
export function communicationsInputFor(
  request: ListAgentCommunicationsRequest,
): Record<string, unknown> {
  return {
    agentIds: [...request.agentIds],
    limit: request.limit ?? DEFAULT_LIMIT,
    ...(request.runIds === undefined ? {} : { runIds: [...request.runIds] }),
    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  };
}

function unavailable(message: string): ShellReadResult<never> {
  return { ok: false, error: { code: 'MessagingUnavailable', message } };
}

function refused(
  error: { code?: unknown; message?: unknown } | undefined,
): ShellReadResult<never> {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'MessagingUnavailable',
      message: typeof error?.message === 'string'
        ? error.message : 'Messaging refused the request',
    },
  };
}

/** Parse from `unknown` at the seam; a wrong shape is a drawable state. */
function readPage(answer: unknown): ShellReadResult<AgentCommunicationsPageView> {
  const frame = answer as {
    ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown };
  } | null;
  if (frame === null || typeof frame !== 'object') {
    return unavailable('Messaging returned no answer');
  }
  if (frame.ok !== true) return refused(frame.error);
  const page = frame.value as { items?: unknown } | null;
  if (page === null || typeof page !== 'object' || !Array.isArray(page.items)) {
    return unavailable('Messaging returned something that is not a page of communications');
  }
  // Verbatim — not spread, not sorted, not renamed.
  return { ok: true, value: page as unknown as AgentCommunicationsPageView };
}

function unknownFields(
  present: readonly string[], allowed: readonly string[], level: string,
): string[] {
  return present.filter((field) => !allowed.includes(field))
    .map((field) => `${level}${field} is not in the frozen projection`);
}

/**
 * The drift guard for the browser-safe copy.
 *
 * It reports in both directions — a field the projection carries that this copy
 * has never heard of, and a required fact that went missing on the way through.
 * The owner's five extras are ALLOWED and NAMED (`COMMUNICATION_VIEW_EXTRAS`):
 * tolerating them silently would hide the very discrepancy the orchestrator has
 * to rule on, while rejecting them would fail against the real product on every
 * row.
 */
export function agentCommunicationDrift(item: unknown): readonly string[] {
  if (item === null || typeof item !== 'object') return ['<item> is not an object'];
  const present = Object.keys(item as Record<string, unknown>);
  const problems = [
    ...unknownFields(present, [...COMMUNICATION_VIEW_FROZEN, ...COMMUNICATION_VIEW_EXTRAS], '<item>.'),
    ...COMMUNICATION_VIEW_REQUIRED
      .filter((field) => !present.includes(field))
      .map((field) => `<item>.${field} is missing from the projection`),
  ];
  const echo = (item as { screenContext?: unknown }).screenContext;
  if (echo !== undefined && echo !== null && typeof echo === 'object') {
    problems.push(...unknownFields(
      Object.keys(echo as Record<string, unknown>),
      SCREEN_CONTEXT_ECHO_FROZEN,
      'screenContext.',
    ));
  }
  return problems;
}

export function createShellCommunicationServices(
  options: { readonly call: B3ReadCall },
): ShellCommunicationServices {
  return {
    async listAgentCommunications(request) {
      try {
        return readPage(await options.call(
          'b3.messaging.listAgentCommunications',
          communicationsInputFor(request),
        ));
      } catch (cause) {
        return unavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}

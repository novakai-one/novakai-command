// shell/contract/communications.ts — the Shell's read of what an Agent has been
// sent, and whether it arrived (FZ-VIEW-013, FZ-VIEW-014; P2 §12.7:2919–2927).
//
// A browser-safe COPY of Messaging's `AgentCommunicationItem`, under the same
// two rules `contract/agentRuns.ts` is copied under: field names are VERBATIM,
// and a leaf that is a closed union upstream is `string` here (the Shell shows
// these; it never decides what the legal set is).
//
// One thing is different enough to say out loud. FZ-VIEW-013 names eight
// members; the implemented projection carries five more (`direction`,
// `inboxState`, `senderAgentId`, `textPreview`, `originBindingId`) that §19.2
// needs to be readable at all. Those are the OWNER's fields, not the Shell's —
// rendering them is not the CL-S violation, inventing one would be — so they
// live in a separate named list rather than being quietly folded into the
// frozen one. `COMMUNICATION_VIEW_FROZEN` is what the freeze blessed;
// `COMMUNICATION_VIEW_EXTRAS` is what the implementation added. Reported as a
// finding, drawn with its source attached, and impossible to confuse.
//
// THE ECHO. `screenContext` is AMD-004's one addition, and FZ-VIEW-014 gives
// Messaging sole authority over it: "no Shell view-model recomputes or supplies
// it." So this module reads it and has no way to produce one — it imports the
// LABEL from contract/screenContext.ts (a function from a value to words) and
// never the DETECTOR (a function from a browser to a value). A test asserts
// that on the source, because the compiler cannot.
import { describeScreenContextSupport, type ScreenContextSupport } from './screenContext.js';

/**
 * FZ-VIEW-015's record, as it arrives ECHOED on a committed Message.
 *
 * Named `ScreenContextEcho` and not `ScreenContext` on purpose. A type called
 * `ScreenContext` sitting in the Shell's contract folder is an invitation to
 * construct one, and the one thing FZ-VIEW-014 forbids is a Shell-made echo.
 * The name says the only way a value of this type can legally come into being.
 * (It is also how the L-07 collision was settled: the B2-era `{app, ref}` type
 * became `FocusSnapshot`, the frozen name stayed with the frozen fact.)
 */
export interface ScreenContextEcho {
  readonly captureId: string;
  readonly capturedAt: string;
  readonly source: string;
  readonly support: ScreenContextSupport;
  readonly advisoryOnly: true;
  readonly contentRef?: string;
  readonly limitations: readonly string[];
}

/** FZ-VIEW-013, verbatim. The extras below are the owner's, marked as such. */
export interface AgentCommunicationItemView {
  readonly messageId: string;
  /** The conversation grouping key (FZ-VIEW-013's `threadId`, renamed by the owner). */
  readonly conversationGroupingKey: string;
  readonly senderPrincipalId: string;
  readonly recipientAgentIds: readonly string[];
  readonly relatedRunIds: readonly string[];
  readonly deliveryState: string;
  readonly occurredAt: string;
  readonly screenContext?: ScreenContextEcho;

  // ── Carried by the implementation, not named by FZ-VIEW-013 ───────────────
  // Optional, every one of them: a host that implements only the freeze is a
  // host this Shell must still be able to draw (the second-host test).
  readonly direction?: string;
  readonly inboxState?: string;
  readonly senderAgentId?: string;
  readonly textPreview?: string;
  readonly originBindingId?: string;
}

/**
 * `Page<T>` as Messaging returns it — `{items}`, and `nextCursor` never set.
 * That is not an oversight this copy hides: see `describePageCompleteness`.
 */
export interface AgentCommunicationsPageView {
  readonly items: readonly AgentCommunicationItemView[];
  readonly nextCursor?: string;
}

/** `ListAgentCommunicationsInput`, passed through untouched (CL-S). */
export interface ListAgentCommunicationsRequest {
  readonly agentIds: readonly string[];
  readonly runIds?: readonly string[];
  readonly conversationGroupingKey?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export const COMMUNICATION_VIEW_FROZEN = [
  'messageId', 'conversationGroupingKey', 'senderPrincipalId', 'recipientAgentIds',
  'relatedRunIds', 'deliveryState', 'occurredAt', 'screenContext',
] as const;

export const COMMUNICATION_VIEW_EXTRAS = [
  'direction', 'inboxState', 'senderAgentId', 'textPreview', 'originBindingId',
] as const;

export const SCREEN_CONTEXT_ECHO_FROZEN = [
  'captureId', 'capturedAt', 'source', 'support', 'advisoryOnly', 'contentRef',
  'limitations',
] as const;

/** Required on every row — an absent one means a fact went missing in transit. */
export const COMMUNICATION_VIEW_REQUIRED = [
  'messageId', 'conversationGroupingKey', 'senderPrincipalId', 'recipientAgentIds',
  'relatedRunIds', 'deliveryState', 'occurredAt',
] as const;

// ── Presentation (DOM-free, so the rules are testable without a screen) ──────

/** `2026-08-06T09:12:00.000Z` → `2026-08-06 09:12 UTC`; unparseable passes through. */
function readableUtc(stamp: string): string {
  const when = new Date(stamp);
  if (Number.isNaN(when.getTime())) return stamp;
  return `${when.toISOString().slice(0, 10)} ${when.toISOString().slice(11, 16)} UTC`;
}

/**
 * Who said it and who it was addressed to. An empty `recipientAgentIds` is a
 * real answer — a Message between people involves no Agent — so it is said in
 * words. `0 recipients` would be the false-zero shape one screen over
 * (FZ-VIEW-010), and this row has no business counting anything.
 */
export function describeParticipants(item: AgentCommunicationItemView): string {
  const recipients = item.recipientAgentIds.length === 0
    ? 'no Agent recipient'
    : item.recipientAgentIds.join(', ');
  return `${item.senderPrincipalId} → ${recipients}`;
}

/**
 * How far it got, in the owner's own word. Never mapped to a friendlier
 * vocabulary: `deliveryState` is a free-form `string` upstream precisely so it
 * can carry the honest answer, and a Shell that translated it would be deciding
 * what "arrived" means on Messaging's behalf.
 */
export function describeDelivery(item: AgentCommunicationItemView): string {
  return item.inboxState === undefined || item.inboxState === item.deliveryState
    ? item.deliveryState
    : `${item.deliveryState} · inbox ${item.inboxState}`;
}

/** The Runs this Message touched — the owner counted them, so none is a fact. */
export function describeRelatedRuns(item: AgentCommunicationItemView): string {
  return item.relatedRunIds.length === 0
    ? 'no Run named'
    : item.relatedRunIds.join(', ');
}

/**
 * FZ-VIEW-014's invariants, checked against what ARRIVED. Reading an echo and
 * saying it contradicts itself is not recomputing it — it is refusing to
 * present a broken value as a sound one.
 */
export function screenContextEchoProblems(echo: ScreenContextEcho): readonly string[] {
  const problems: string[] = [];
  if (echo.support === 'unavailable' && echo.contentRef !== undefined) {
    problems.push('echo says support is unavailable but carries a contentRef');
  }
  if (echo.advisoryOnly !== true) {
    problems.push('echo is not marked advisory — FZ-VIEW-015 says it always is');
  }
  return problems;
}

/**
 * The echo, in the same three words FZ-VIEW-016 puts on the terminal — and the
 * two different reasons it can be absent, told apart rather than merged:
 *
 *   mirrored from a transcript → FZ-VIEW-014 says there IS no screenContext on
 *                                a Message committed that way. Contract working.
 *   otherwise                  → the field did not arrive. Today that is true of
 *                                every row, because AMD-004's addition is not
 *                                implemented anywhere in Messaging yet (L-10).
 *
 * Merging those two would turn a working contract into a permanent alarm, or a
 * missing field into a shrug. Both are the same lie in opposite directions.
 */
export function describeScreenContextEcho(item: AgentCommunicationItemView): string {
  const echo = item.screenContext;
  if (echo === undefined) {
    return item.originBindingId === undefined
      ? 'not carried by this projection'
      : 'none — mirrored from a transcript, which carries no screen context';
  }
  return `${describeScreenContextSupport(echo.support)} · echoed by Messaging`;
}

/**
 * The contradiction, on its own line and in its own words.
 *
 * It used to be appended to the sentence above, and in a screenshot that read
 * as one long muted string — the fact and its refutation at the same ink tier,
 * which is exactly the defect B1.4 found between the Shell's statement and the
 * Runtime's. A row where the echo contradicts itself is the ONE exception on
 * this screen, so it gets the one bright line (see communications.css) and
 * every healthy row stays quiet.
 */
export function describeEchoProblems(item: AgentCommunicationItemView): string {
  return item.screenContext === undefined
    ? ''
    : screenContextEchoProblems(item.screenContext).join(' · ');
}

/**
 * Whose messages these are. Total: before the subjects are known there is no
 * scope to state, and a screen that printed "Messages involving" with nothing
 * after it — which is what the no-Runtime path drew — is a sentence that stops
 * mid-air. Said, or not said. Never half-said.
 */
export function describeScope(request: ListAgentCommunicationsRequest): string {
  return request.agentIds.length === 0
    ? ''
    : `Messages involving ${request.agentIds.join(', ')}`;
}

/**
 * L-11. `listAgentCommunications` slices to `limit` and never sets
 * `nextCursor`, so a truncated page is byte-identical to a complete one. The
 * Shell cannot fix that here (CL-O) — but it can decline to imply completeness,
 * and it can do so from a fact it owns: the limit IT asked for.
 */
export function describePageCompleteness(
  request: ListAgentCommunicationsRequest,
  page: AgentCommunicationsPageView,
): string {
  if (page.nextCursor !== undefined) {
    return `${page.items.length} shown · more follow this page`;
  }
  if (request.limit === undefined || page.items.length < request.limit) return '';
  return `${page.items.length} shown — this page is full and carries no cursor, `
    + 'so there may be more';
}

// ── The per-row manifest ─────────────────────────────────────────────────────

/**
 * Where a fact on the row came from. `not-carried` is the honest one: the
 * projection could have supplied this and did not, which the screen draws
 * rather than hides (the device B0 used for `controllers`).
 */
export type CommunicationFactSource = 'frozen' | 'implementation-extra' | 'not-carried';

export interface CommunicationFact {
  readonly id: string;
  /** What Chris reads as the label — and how a test finds the fact on screen. */
  readonly term: string;
  /**
   * Drawn as the row's status rather than as another labelled line. Delivery
   * was in both places, and one fact in two places on one row is a reader
   * asking which of them to believe. The manifest still owns the words; only
   * where they land changes.
   */
  readonly headline?: true;
  /**
   * Per ROW, not per fact. Whether the echo arrived is a property of the
   * Message, so a static `source` would have to lie about one row or the other.
   */
  readonly sourceOf: (item: AgentCommunicationItemView) => CommunicationFactSource;
  readonly describe: (item: AgentCommunicationItemView) => string;
}

const frozen = (source: CommunicationFactSource = 'frozen') => () => source;

export const COMMUNICATION_FACTS: readonly CommunicationFact[] = [
  {
    id: 'participants', term: 'Between', sourceOf: frozen(),
    describe: describeParticipants,
  },
  {
    id: 'delivery', term: 'Delivery', sourceOf: frozen(), headline: true,
    describe: describeDelivery,
  },
  {
    id: 'runs', term: 'Runs', sourceOf: frozen(),
    describe: describeRelatedRuns,
  },
  {
    id: 'when', term: 'Occurred', sourceOf: frozen(),
    describe: (item) => readableUtc(item.occurredAt),
  },
  {
    id: 'conversation', term: 'Conversation', sourceOf: frozen(),
    describe: (item) => item.conversationGroupingKey,
  },
  {
    id: 'screen-context', term: 'Screen context',
    sourceOf: (item) => (
      item.screenContext === undefined && item.originBindingId === undefined
        ? 'not-carried'
        : 'frozen'),
    describe: describeScreenContextEcho,
  },
  {
    id: 'direction', term: 'Direction', sourceOf: frozen('implementation-extra'),
    describe: (item) => item.direction ?? '',
  },
  {
    // Last, and blank on every healthy row, so the exception is the only thing
    // that ever appears at the bottom of a row.
    id: 'echo-problem', term: 'Echo problem', sourceOf: frozen(),
    describe: describeEchoProblems,
  },
];

/** Lookup by id. Throws on an unknown id — a typo must not silently draw less. */
export function communicationFact(id: string): CommunicationFact {
  const found = COMMUNICATION_FACTS.find((fact) => fact.id === id);
  if (found === undefined) throw new Error(`no communication fact "${id}"`);
  return found;
}

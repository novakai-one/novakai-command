/**
 * The B3c Transcript capability contract — B3V4-P2 §8.2, §12.5, §13.9, §27.
 *
 * Transcript owns custody: which Run a provider conversation belongs to, how
 * far it has been mirrored, what turned out to be noise, and which
 * provider-native subagents were OBSERVED without ever being controlled.
 *
 * The one thing this contract cannot do is write a Message. It asks Messaging
 * to (§3.3, red gate 18), and Messaging decides what that means.
 */

import type {
  AuthenticatedPrincipal, B3Result, EventCursor, Page, SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  AgentId, AgentRunId, ObservedSubagent, ObservedSubagentId, ProviderKind,
  ProviderSessionId, TranscriptBinding, TranscriptBindingId, TranscriptLineId,
} from './records.js';

export interface BindTranscriptToRunInput {
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly provider: ProviderKind;
  readonly providerSessionId: ProviderSessionId;
  /**
   * The Thread mirrored Messages land in. Required, because §12.5 requires a
   * threadId on every commit and a mirror that had to invent one per turn
   * would scatter one conversation across N Threads.
   */
  readonly threadId: string;
}

export interface IngestTranscriptSourceInput {
  readonly bindingId: TranscriptBindingId;
  /**
   * CAS on the watermark. A caller that believes the mirror is further along
   * than it is has stale state, and letting it ingest anyway would re-mirror
   * turns it thinks are already done.
   */
  readonly expectedWatermark?: string;
  readonly maxLines: number;
}

/**
 * One human-role line this pass durably committed, reduced to the facts that
 * identify it. B3d: a consumer correlating a provider turn against something it
 * caused needs the line's identity, its position and its content digests — the
 * counts alone say a turn arrived without saying which.
 *
 * HUMAN-ROLE ONLY, deliberately. An input Novakai caused arrives as a human
 * turn, so every other role is noise for this purpose; announcing all of them
 * would put an unbounded slab of an assistant's output on §15's bounded stream
 * to say nothing new. `textDigest` rather than the text for the same reason,
 * and because a turn's content is not the event stream's business.
 */
export interface CommittedInputLine {
  readonly transcriptLineId: TranscriptLineId;
  readonly sourcePosition: string;
  /** Digest of the raw source row — §8.2's corruption comparison. */
  readonly sourceDigest: string;
  /** SHA-256 hex over the classified text: what a person would have read. */
  readonly textDigest: string;
}

export interface TranscriptIngestOutcome {
  readonly bindingId: TranscriptBindingId;
  readonly discovered: number;
  readonly filtered: number;
  readonly mirrored: number;
  readonly quarantined: number;
  readonly nextWatermark?: string;
  /** Why ingestion stopped early, when it did. Never a silent short read. */
  readonly haltedBy?: 'quarantine' | 'max-lines' | 'source-unavailable' | 'stage-pause';
  /** The human turns this pass committed. Absent when it committed none. */
  readonly committedInputLines?: readonly CommittedInputLine[];
}

export interface PromoteMirrorWatermarkInput {
  readonly bindingId: TranscriptBindingId;
  readonly expectedWatermark?: string;
  readonly nextWatermark: string;
  readonly outcomeRefs: readonly string[];
}

export interface ListObservedSubagentsInput {
  readonly bindingId?: TranscriptBindingId;
  readonly agentRunId?: AgentRunId;
  readonly cursor?: EventCursor;
  readonly limit: number;
}

export interface PromoteObservedSubagentInput {
  readonly observedSubagentId: ObservedSubagentId;
  readonly roleProfileId: string;
  readonly displayName: string;
}

/**
 * §12.7's promotion, and DEC-B3V4-18's refusal.
 *
 * "Observation never silently becomes control." A provider-native subagent
 * that cannot be identified and authorised from provider evidence is NOT
 * promoted, and `observation-only` is a legal, typed, non-error outcome —
 * saying so is the point.
 */
export type PromoteObservedSubagentOutcome =
  | { readonly kind: 'promoted'; readonly subagent: ObservedSubagent; readonly agentId: AgentId }
  | {
      readonly kind: 'observation-only';
      readonly subagent: ObservedSubagent;
      readonly reason: string;
      readonly missingEvidence: readonly string[];
    };

export interface TranscriptCommands {
  bindTranscriptToRun(
    ctx: SystemCommandContext<'sys_agent_runtime'>, input: BindTranscriptToRunInput,
  ): Promise<B3Result<TranscriptBinding>>;

  ingestTranscriptSource(
    ctx: SystemCommandContext<'sys_transcript'>, input: IngestTranscriptSourceInput,
  ): Promise<B3Result<TranscriptIngestOutcome>>;

  promoteMirrorWatermark(
    ctx: SystemCommandContext<'sys_transcript'>, input: PromoteMirrorWatermarkInput,
  ): Promise<B3Result<TranscriptBinding>>;

  promoteObservedSubagent(
    ctx: SystemCommandContext<'sys_transcript'>, input: PromoteObservedSubagentInput,
  ): Promise<B3Result<PromoteObservedSubagentOutcome>>;
}

export interface TranscriptQueries {
  getTranscriptBinding(
    principal: AuthenticatedPrincipal, agentRunId: AgentRunId,
  ): Promise<B3Result<TranscriptBinding>>;

  listObservedSubagents(
    principal: AuthenticatedPrincipal, input: ListObservedSubagentsInput,
  ): Promise<B3Result<Page<ObservedSubagent>>>;
}

export type B3TranscriptContract = TranscriptCommands & TranscriptQueries;

// --- the source seam ----------------------------------------------------------

/** One line as the provider wrote it, before anyone decides what it means. */
export interface SourceLine {
  /** Opaque, monotonically ordered within one source. The watermark speaks this. */
  readonly position: string;
  readonly role:
    | 'user' | 'assistant' | 'system' | 'tool' | 'tool_call' | 'tool_result' | 'attachment';
  readonly text: string;
  /** Content digest at this position. A change here is corruption (§8.2). */
  readonly digest: string;
  readonly occurredAt?: string;
  /** Provider-native subagent identity, when the line carries one. */
  readonly nativeSubagentId?: string;
  readonly parentNativeSubagentId?: string;
}

export type SourceReadOutcome =
  | { readonly kind: 'lines'; readonly lines: readonly SourceLine[]; readonly more: boolean }
  /** The source does not exist yet. Explicit, never silent absence (§25-B3c). */
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** One already-committed position, reduced to the only thing §8.2 compares. */
export interface SourcePositionDigest {
  readonly position: string;
  readonly digest: string;
}

export type SourcePrefixOutcome =
  | { readonly kind: 'digests'; readonly digests: readonly SourcePositionDigest[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Where transcript bytes come from. A seam because it genuinely varies: a
 * provider file on disk in production, a fixture in a test. It also makes the
 * quarantine suite runnable WITHOUT touching provider originals (§27), which
 * is the only way to test corruption honestly.
 */
export interface TranscriptSourcePort {
  /**
   * Read from `fromPosition` INCLUSIVE — the watermark line itself comes back
   * on every pass, not just the ones after it.
   *
   * That inclusiveness is the whole detection mechanism for §8.2's "different
   * digest at the same source position is corruption". Resuming strictly AFTER
   * the watermark never re-reads a position already mirrored, so a provider
   * file rewritten underneath us would be invisible: the mirror would carry on
   * from a line whose content no longer matches what was committed. One
   * re-read line per pass is what buys that check.
   */
  read(
    binding: TranscriptBinding, fromPosition: string | undefined, maxLines: number,
  ): Promise<SourceReadOutcome>;

  /**
   * Every source position at or below `throughPosition`, reduced to its
   * digest — the committed prefix, as the source holds it RIGHT NOW.
   *
   * Spec ruling Q9: §8.2 makes a different digest at the same source position
   * corruption with no watermark qualification, so a rewrite BELOW the
   * watermark is corruption too. Watermark-inclusive forward resumption
   * re-reads exactly one line, which cannot see it. This is the horizon the
   * ruling requires: the mirror revalidates its whole committed prefix against
   * the durable ledger before it processes or commits anything beyond the
   * watermark.
   *
   * Digests only, and never normalised: §8.2 compares content, and the roles,
   * subagent ids and text of a line the mirror has already decided about are
   * work nobody needs done twice.
   *
   * Positions the source itself skips (blank rows) are omitted, exactly as
   * `read` omits them — the two must agree on what a position IS, or the
   * comparison manufactures conflicts out of formatting.
   */
  readPrefixDigests(
    binding: TranscriptBinding, throughPosition: string,
  ): Promise<SourcePrefixOutcome>;
}

/**
 * Fault injection for the mirror pipeline (§24.3 item 18, surface #9).
 *
 * Without a public pause point, "crash between the Message commit and the
 * watermark advance" is only testable from inside the package — which means
 * the recovery it proves is only ever proved by its own author.
 */
export type MirrorStage =
  | 'after-read'
  | 'after-classify'
  | 'after-message-commit'
  | 'before-watermark-advance'
  | 'after-quarantine';

export interface MirrorStageHooks {
  /** Return `'halt'` to stop the pass cleanly at this stage. */
  onStage?(stage: MirrorStage, detail: Readonly<Record<string, unknown>>):
    Promise<'continue' | 'halt'> | 'continue' | 'halt';
}

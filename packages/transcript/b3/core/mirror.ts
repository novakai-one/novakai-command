/**
 * The mirror pipeline — §13.9, §8.2, §24.6.
 *
 *   discovered → filtered (noise; outcome recorded)
 *              → committed-to-Messaging + endpoint effect
 *              → quarantined (conflict/corruption; watermark stops)
 *
 * Two rules govern everything here and both are about the watermark:
 *
 *   1. It advances only AFTER a durable outcome. Not after a decision, not
 *      after a successful read — after the Message is committed or the filter
 *      outcome is written. A watermark ahead of durable truth is a turn that
 *      silently never arrives.
 *   2. It never advances over quarantine. A source that changed underneath us
 *      is corrupt, and mirroring past the corruption would commit turns whose
 *      provenance is already known to be wrong.
 *
 * Provider originals are never written, never moved, never truncated (§27).
 * Everything this module persists lives under `.novakai`.
 */

import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type B3Result, type ClientOpId,
} from '@novakai/foundation/contract';

import type {
  IngestTranscriptSourceInput, MirrorStage, MirrorStageHooks, SourceLine,
  TranscriptIngestOutcome, TranscriptSourcePort,
} from '../contract/api.js';
import type {
  NormalisedTranscriptTurn, TranscriptBinding, TranscriptLineId,
} from '../contract/records.js';

export { mirrorLedgerId, type MirrorLedgerEntry } from './ledger.js';
import {
  mirrorLedgerId, recordLedger,
  type MirrorLedgerEntry,
} from './ledger.js';
import { classifyTurn } from './noise.js';
import { verifyCommittedPrefix } from './prefix-guard.js';
import type { TranscriptStore } from './store.js';

/** What Messaging is asked to do with a conversation turn. Transcript never writes it. */
export interface MessagingMirrorPort {
  commitTerminalOriginatedMessage(input: {
    readonly bindingId: string;
    readonly agentId: string;
    readonly threadId: string;
    readonly sourceEndpointClaimId: string;
    readonly turn: NormalisedTranscriptTurn;
  }): Promise<B3Result<{ readonly messageId: string; readonly duplicate: boolean }>>;
  /** The endpoint the Agent currently owns — the one a mirror must NOT return to. */
  currentEndpointClaimId(agentId: string): Promise<string | null>;
}

export interface MirrorDeps {
  readonly store: TranscriptStore;
  readonly source: TranscriptSourcePort;
  readonly messaging: MessagingMirrorPort;
  readonly hooks?: MirrorStageHooks;
  /**
   * The requester's trace correlation for this ingest (§4.4 trusted context).
   * Q10 records it on any tombstone this pass asks Foundation to write, so a
   * quarantine can be traced back to the pass that found the corruption.
   */
  readonly traceId?: string;
  /** Records a native subagent seen on a line. Injected to avoid a cycle. */
  readonly observeSubagent?: (input: {
    readonly bindingId: string;
    readonly providerNativeId: string;
    readonly observedParentNativeId?: string;
    readonly evidenceLineIds: readonly string[];
  }) => Promise<B3Result<unknown>>;
}

interface PassCounters {
  discovered: number;
  filtered: number;
  mirrored: number;
  quarantined: number;
}

export async function ingestTranscriptSource(
  deps: MirrorDeps, binding: TranscriptBinding, input: IngestTranscriptSourceInput,
): Promise<B3Result<TranscriptIngestOutcome>> {
  if (input.expectedWatermark !== undefined
    && input.expectedWatermark !== binding.mirrorWatermark) {
    return b3fail(b3err('VersionConflict',
      'the mirror watermark moved since this ingest was planned',
      {
        objectId: binding.id,
        expected: input.expectedWatermark,
        actual: binding.mirrorWatermark ?? null,
      }, true));
  }
  // §13.9: a binding already holding a quarantine does not resume by itself.
  // Resuming would mean mirroring past a conflict nobody has looked at.
  if (binding.sourceDiscoveryState === 'corrupt') {
    return b3fail(b3err('TranscriptCorrupt',
      `binding ${binding.id} is quarantined at ${binding.quarantinedPosition ?? 'an earlier position'}`,
      {
        bindingId: binding.id,
        sourcePosition: binding.quarantinedPosition ?? '',
        expectedDigest: '', actualDigest: '',
      }, false));
  }

  const read = await deps.source.read(binding, binding.mirrorWatermark, input.maxLines);
  if (read.kind === 'missing') {
    // Explicit, not silent (§25-B3c). `waiting` while a Run is alive and its
    // file has not appeared yet; the caller decides when that becomes missing.
    // Written only when it CHANGES: under the pump an unconditional update
    // would append a custody record per second per Run, saying nothing new.
    if (binding.sourceDiscoveryState !== 'waiting') {
      await setState(deps.store, binding, { sourceDiscoveryState: 'waiting' });
    }
    return b3ok(empty(binding, 'source-unavailable'));
  }
  if (read.kind === 'unavailable') {
    return b3fail(b3err('TranscriptSourceUnavailable', read.reason,
      { bindingId: binding.id, reason: read.reason }, true));
  }

  if (await halted(deps, 'after-read', { lines: read.lines.length })) {
    return b3ok(empty(binding, 'stage-pause'));
  }

  // Q9, in the order the ruling writes it: BEFORE processing or committing
  // anything beyond the watermark, revalidate the committed prefix. A pass with
  // nothing new in it is not an advancement, so it costs nothing — the guard
  // runs only when this read actually carries a position past the watermark.
  const guarded = await guardPrefix(deps, binding, read.lines);
  if (guarded !== null) return guarded;

  return runPass(deps, binding, read.lines, read.more);
}

/**
 * The prefix check, and the pass it ends when the source disagrees with the
 * ledger: quarantine at the earliest divergence, watermark untouched, nothing
 * from this batch committed.
 *
 * Returns null when the pass should carry on.
 */
async function guardPrefix(
  deps: MirrorDeps, binding: TranscriptBinding, lines: readonly SourceLine[],
): Promise<B3Result<TranscriptIngestOutcome> | null> {
  const watermark = binding.mirrorWatermark;
  if (watermark === undefined) return null;
  if (!lines.some((line) => line.position > watermark)) return null;

  const verdict = await verifyCommittedPrefix(deps, binding, watermark);
  if (verdict.kind === 'intact') return null;
  if (verdict.kind === 'failed') return verdict.error;
  // The source stopped answering between the two reads. Nothing is proved, so
  // nothing is quarantined and — the part that matters — nothing advances.
  if (verdict.kind === 'unreadable') return b3ok(empty(binding, 'source-unavailable'));

  const stopped = await quarantineAt(deps, binding, verdict.position, verdict.ledgerId);
  if (!stopped.ok) return stopped;
  return b3ok(outcome(
    binding, { discovered: 0, filtered: 0, mirrored: 0, quarantined: 1 },
    binding.mirrorWatermark, 'quarantine',
  ));
}

/**
 * What one source line turned into. `halt` and `quarantine` both stop the pass
 * where it stands — the difference is that quarantine also freezes the binding.
 */
type LineOutcome =
  | { readonly kind: 'already-done' }
  | { readonly kind: 'filtered' }
  | { readonly kind: 'mirrored' }
  | { readonly kind: 'quarantined' }
  | { readonly kind: 'halt' }
  | { readonly kind: 'failed'; readonly error: B3Result<never> };

async function runPass(
  deps: MirrorDeps, binding: TranscriptBinding,
  lines: readonly SourceLine[], more: boolean,
): Promise<B3Result<TranscriptIngestOutcome>> {
  const counters: PassCounters = { discovered: 0, filtered: 0, mirrored: 0, quarantined: 0 };
  let watermark = binding.mirrorWatermark;
  let current = binding;

  for (const line of lines) {
    counters.discovered += 1;
    const handled = await handleLine(deps, current, line);

    if (handled.kind === 'failed') return handled.error;
    tally(counters, handled.kind);
    const stop = stopReasonFor(handled.kind);
    if (stop !== null) return b3ok(outcome(binding, counters, watermark, stop));

    // The watermark moves ONLY here, after a durable outcome for this line.
    watermark = line.position;
    current = { ...current, mirrorWatermark: watermark };
  }

  const advanced = await persistProgress(deps.store, binding, watermark, lines.length);
  if (!advanced.ok) return advanced;

  return b3ok(outcome(binding, counters, watermark, more ? 'max-lines' : undefined));
}

function tally(counters: PassCounters, kind: LineOutcome['kind']): void {
  if (kind === 'filtered') counters.filtered += 1;
  if (kind === 'mirrored') counters.mirrored += 1;
  if (kind === 'quarantined') counters.quarantined += 1;
}

/** The two outcomes that end the pass, and how the caller should describe it. */
const stopReasonFor = (
  kind: LineOutcome['kind'],
): TranscriptIngestOutcome['haltedBy'] | null => {
  if (kind === 'halt') return 'stage-pause';
  if (kind === 'quarantined') return 'quarantine';
  return null;
};

/** One line, from ledger check through to a durable outcome. */
async function handleLine(
  deps: MirrorDeps, binding: TranscriptBinding, line: SourceLine,
): Promise<LineOutcome> {
  const ledgerId = mirrorLedgerId(binding.id, line.position);
  const seen = await checkLedger(deps, binding, line, ledgerId);
  if (seen !== null) return seen;

  // A line carrying a provider-native subagent id is EVIDENCE that one exists.
  // Recording it here — before any decision about the turn itself — is what
  // makes "listed as observed work with evidence" true for tool lines too,
  // which is where most native subagent activity actually shows up.
  const observed = await noteSubagent(deps, binding, line, ledgerId);
  if (observed !== null) return observed;

  const classified = classifyTurn({ role: line.role, text: line.text });
  if (await halted(deps, 'after-classify', { position: line.position })) {
    return { kind: 'halt' };
  }

  if (classified.kind === 'filtered') {
    const recorded = await recordLedger(deps.store, {
      id: ledgerId, bindingId: binding.id, position: line.position, digest: line.digest,
      outcome: 'filtered', filterReason: classified.reason,
    });
    return recorded.ok ? { kind: 'filtered' } : { kind: 'failed', error: recorded };
  }

  return mirrorOne(deps, binding, line, ledgerId, classified.role, classified.text);
}

/**
 * What the ledger already says about this position, or null when it says
 * nothing and the line is genuinely new.
 *
 * §8.2 in two lines: same position and same digest is idempotent; same
 * position and a DIFFERENT digest means the source was rewritten underneath a
 * turn already committed, which is corruption.
 */
async function checkLedger(
  deps: MirrorDeps, binding: TranscriptBinding, line: SourceLine, ledgerId: TranscriptLineId,
): Promise<LineOutcome | null> {
  const existing = await deps.store.read<MirrorLedgerEntry>('transcriptLine', ledgerId);
  if (!existing.ok) return { kind: 'failed', error: existing };
  if (existing.value === null) return null;
  if (existing.value.sourceDigest === line.digest) return { kind: 'already-done' };

  const stopped = await quarantineAt(deps, binding, line.position, ledgerId);
  if (!stopped.ok) return { kind: 'failed', error: stopped };
  return { kind: 'quarantined' };
}

/**
 * Record a provider-native subagent seen on this line. Never promotes it:
 * DEC-B3V4-18 keeps that an explicit, separate act.
 */
async function noteSubagent(
  deps: MirrorDeps, binding: TranscriptBinding, line: SourceLine, ledgerId: TranscriptLineId,
): Promise<LineOutcome | null> {
  if (line.nativeSubagentId === undefined) return null;
  const recorded = await deps.observeSubagent?.({
    bindingId: binding.id,
    providerNativeId: line.nativeSubagentId,
    ...(line.parentNativeSubagentId === undefined
      ? {} : { observedParentNativeId: line.parentNativeSubagentId }),
    evidenceLineIds: [ledgerId],
  });
  if (recorded !== undefined && !recorded.ok) return { kind: 'failed', error: recorded };
  return null;
}

async function mirrorOne(
  deps: MirrorDeps, binding: TranscriptBinding, line: SourceLine,
  ledgerId: TranscriptLineId, role: 'human' | 'assistant', text: string,
): Promise<LineOutcome> {
  const turn: NormalisedTranscriptTurn = {
    transcriptLineId: ledgerId,
    bindingId: binding.id,
    sourcePosition: line.position,
    role,
    text,
    ...(line.occurredAt === undefined ? {} : { occurredAt: line.occurredAt }),
    sourceDigest: line.digest,
    providerMetadata: {},
  };
  const endpointClaimId = await deps.messaging.currentEndpointClaimId(binding.agentId);
  const committed = await deps.messaging.commitTerminalOriginatedMessage({
    bindingId: binding.id,
    agentId: binding.agentId,
    threadId: binding.threadId,
    // No live endpoint is not a reason to lose a turn: the mirror still
    // commits, and there is no endpoint for it to loop back into.
    sourceEndpointClaimId: endpointClaimId ?? '',
    turn,
  });
  if (!committed.ok) return { kind: 'failed', error: committed };

  if (await halted(deps, 'after-message-commit', { position: line.position })) {
    // The Message is durable; the ledger and watermark are not. That is the
    // crash window §13.9 cares about, and the replay must recognise the
    // Message as already committed rather than write a second one.
    return { kind: 'halt' };
  }

  const recorded = await recordLedger(deps.store, {
    id: ledgerId, bindingId: binding.id, position: line.position, digest: line.digest,
    outcome: 'mirrored', role, messageId: committed.value.messageId,
  });
  if (!recorded.ok) return { kind: 'failed', error: recorded };

  if (await halted(deps, 'before-watermark-advance', { position: line.position })) {
    return { kind: 'halt' };
  }
  return { kind: 'mirrored' };
}

/**
 * Persist how far the pass got. A source that produced lines is `bound` even
 * if every one of them was noise — the file exists and is being read, which is
 * a different fact from "nothing has arrived yet".
 */
async function persistProgress(
  store: TranscriptStore, binding: TranscriptBinding,
  watermark: string | undefined, lineCount: number,
): Promise<B3Result<unknown>> {
  if (watermark !== binding.mirrorWatermark) {
    return setState(store, binding, {
      mirrorWatermark: watermark, sourceDiscoveryState: 'bound',
    });
  }
  if (binding.sourceDiscoveryState !== 'bound' && lineCount > 0) {
    return setState(store, binding, { sourceDiscoveryState: 'bound' });
  }
  return b3ok(binding);
}

async function quarantineAt(
  deps: MirrorDeps, binding: TranscriptBinding, position: string, ledgerId: string,
): Promise<B3Result<null>> {
  const tombstoned = await deps.store.quarantine(
    'transcriptLine', ledgerId, keyFor(`quarantine:${ledgerId}`), deps.traceId,
  );
  if (!tombstoned.ok) return tombstoned;
  const frozen = await setState(deps.store, binding, {
    sourceDiscoveryState: 'corrupt',
    quarantinedPosition: position,
    watcherState: 'recovery-required',
  });
  if (!frozen.ok) return b3fail(frozen.error);
  await halted(deps, 'after-quarantine', { position });
  return b3ok(null);
}

async function setState(
  store: TranscriptStore, binding: TranscriptBinding, patch: Record<string, unknown>,
): Promise<B3Result<TranscriptBinding>> {
  return store.update<TranscriptBinding>(
    binding.id, patch, binding.recordVersion,
    keyFor(`binding:${binding.id}:${JSON.stringify(patch)}`),
  );
}

/**
 * A stage hook that says `halt` stops the pass where it stands, leaving durable
 * state exactly as far as it got. That is the point: the next pass has to be
 * able to resume from it.
 */
async function halted(
  deps: MirrorDeps, stage: MirrorStage, detail: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (deps.hooks?.onStage === undefined) return false;
  return (await deps.hooks.onStage(stage, detail)) === 'halt';
}

const keyFor = (effect: string): ClientOpId => deriveClientOpId(`transcript:${effect}`);

const empty = (
  binding: TranscriptBinding, haltedBy: TranscriptIngestOutcome['haltedBy'],
): TranscriptIngestOutcome => ({
  bindingId: binding.id,
  discovered: 0, filtered: 0, mirrored: 0, quarantined: 0,
  ...(binding.mirrorWatermark === undefined ? {} : { nextWatermark: binding.mirrorWatermark }),
  ...(haltedBy === undefined ? {} : { haltedBy }),
});

const outcome = (
  binding: TranscriptBinding, counters: PassCounters, watermark: string | undefined,
  haltedBy: TranscriptIngestOutcome['haltedBy'],
): TranscriptIngestOutcome => ({
  bindingId: binding.id,
  ...counters,
  ...(watermark === undefined ? {} : { nextWatermark: watermark }),
  ...(haltedBy === undefined ? {} : { haltedBy }),
});

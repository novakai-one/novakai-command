/**
 * The B3c Transcript capability, composed — §12.5, §13.9, DEC-B3V4-18.
 */

import {
  b3err, b3fail, b3ok, deriveClientOpId, mintObservedSubagentId, mintTranscriptBindingId,
  nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type ClientOpId, type Page,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createHash } from 'node:crypto';

import type {
  B3TranscriptContract, BindTranscriptToRunInput, IngestTranscriptSourceInput,
  ListObservedSubagentsInput, MirrorStageHooks, PromoteMirrorWatermarkInput,
  PromoteObservedSubagentInput, PromoteObservedSubagentOutcome, TranscriptIngestOutcome,
  TranscriptSourcePort,
} from '../contract/api.js';
import type {
  AgentId, AgentRunId, ObservedSubagent, ObservedSubagentId, TranscriptBinding,
  TranscriptBindingId,
} from '../contract/records.js';
import { ingestTranscriptSource, type MessagingMirrorPort } from './mirror.js';
import { requireDurableOutcomes } from './watermark-outcomes.js';
import type { TranscriptStore } from './store.js';

export interface B3TranscriptOptions {
  readonly store: TranscriptStore;
  readonly source: TranscriptSourcePort;
  readonly messaging: MessagingMirrorPort;
  /** Optional promotion authority. Absent means no promotion is possible. */
  readonly promotion?: SubagentPromotionPort;
  readonly hooks?: MirrorStageHooks;
  /**
   * Where §15's committed facts go. Transcript owns the facts; the composition
   * root owns the stream, so one cursor covers every capability (§24.4).
   */
  readonly emit?: CapabilityEventEmitter;
}

export type CapabilityEventEmitter = (
  kind: string, payload: Readonly<Record<string, unknown>>,
) => void;

/**
 * Promotion crosses into Agents, which owns Agent identity. Transcript asks;
 * it never mints an Agent (§3.3). A host with no promotion authority wired is
 * observation-only, and says so rather than failing.
 */
export interface SubagentPromotionPort {
  promote(input: {
    readonly observedSubagentId: ObservedSubagentId;
    readonly roleProfileId: string;
    readonly displayName: string;
    readonly providerNativeId: string;
    readonly evidenceLineIds: readonly string[];
  }): Promise<B3Result<{ readonly agentId: AgentId }>>;
}

const unknownBinding = (id: string): ReturnType<typeof b3err> =>
  b3err('ValidationFailed', `no transcript binding ${id}`,
    { issues: [{ path: 'bindingId', message: 'unknown binding' }] }, false);

const keyFor = (effect: string): ClientOpId => deriveClientOpId(`transcript:${effect}`);

const bindingEvent = 'transcript.binding.changed';
const subagentEvent = 'transcript.observed-subagent.changed';

/**
 * Did this pass write a durable outcome anyone can act on?
 *
 * `discovered` alone is not enough: a pass whose only line was the re-read
 * watermark line recognises its own ledger entry and writes nothing.
 */
const committedSomething = (outcome: TranscriptIngestOutcome): boolean =>
  outcome.filtered > 0 || outcome.mirrored > 0 || outcome.quarantined > 0;

const bindingPayload = (binding: TranscriptBinding): Record<string, unknown> => ({
  bindingId: binding.id,
  agentId: binding.agentId,
  agentRunId: binding.agentRunId,
  provider: binding.provider,
  sourceDiscoveryState: binding.sourceDiscoveryState,
  watcherState: binding.watcherState,
  ...(binding.mirrorWatermark === undefined
    ? {} : { mirrorWatermark: binding.mirrorWatermark }),
});

const subagentPayload = (subagent: ObservedSubagent): Record<string, unknown> => ({
  observedSubagentId: subagent.id,
  bindingId: subagent.bindingId,
  providerNativeId: subagent.providerNativeId,
  status: subagent.status,
  ...(subagent.promotedAgentId === undefined
    ? {} : { promotedAgentId: subagent.promotedAgentId }),
});

export function composeB3Transcript(options: B3TranscriptOptions): B3TranscriptContract {
  const { store } = options;
  const emit = options.emit ?? (() => undefined);

  /** Emit only after the fact is durable. */
  function announce<T>(
    result: B3Result<T>, kind: string, payload: (value: T) => Record<string, unknown>,
  ): B3Result<T> {
    if (result.ok) emit(kind, payload(result.value));
    return result;
  }

  async function bindingById(id: string): Promise<TranscriptBinding | null> {
    const found = await store.read<TranscriptBinding>('transcriptBinding', id);
    return found.ok ? found.value : null;
  }

  return {
    async bindTranscriptToRun(
      _ctx: SystemCommandContext<'sys_agent_runtime'>, input: BindTranscriptToRunInput,
    ) {
      const id = mintTranscriptBindingId(
        input.agentRunId, input.provider, input.providerSessionId,
      ) as TranscriptBindingId;
      const existing = await bindingById(id);
      // Binding is get-or-create: a Run rebound after a Runtime restart must
      // find its own custody record, watermark and all, not start over at zero.
      if (existing !== null) return b3ok(existing);

      // `waiting`, deliberately, and never absence: the provider file for a
      // just-spawned Run does not exist yet, and §25-B3c requires the first
      // bind to say which of bound/waiting/missing it is.
      return announce(await store.create<TranscriptBinding>({
        kind: 'transcriptBinding',
        id,
        schemaVersion: 1,
        createdAt: nowIsoUtc(),
        permissionLevel: 'private',
        createdBy: 'sys_agent_runtime',
        agentId: input.agentId,
        agentRunId: input.agentRunId,
        provider: input.provider,
        providerSessionId: input.providerSessionId,
        sourceLocatorDigest: createHash('sha256')
          .update(`${input.provider}${input.providerSessionId}`, 'utf8')
          .digest('hex'),
        sourceDiscoveryState: 'waiting',
        watcherState: 'live',
        threadId: input.threadId,
      } as never, keyFor(`bind:${id}`)), bindingEvent, bindingPayload);
    },

    async ingestTranscriptSource(
      context: SystemCommandContext<'sys_transcript'>, input: IngestTranscriptSourceInput,
    ): Promise<B3Result<TranscriptIngestOutcome>> {
      const binding = await bindingById(input.bindingId);
      if (binding === null) return b3fail(unknownBinding(input.bindingId));
      const ingested = await ingestTranscriptSource({
        store,
        source: options.source,
        messaging: options.messaging,
        // Q10: the requester's correlation, carried to any tombstone this pass
        // asks Foundation for. It is trusted context, never request JSON.
        traceId: context.traceId,
        observeSubagent: (seen) => recordObservedSubagent(store, {
          bindingId: seen.bindingId as TranscriptBindingId,
          providerNativeId: seen.providerNativeId,
          ...(seen.observedParentNativeId === undefined
            ? {} : { observedParentNativeId: seen.observedParentNativeId }),
          evidenceLineIds: seen.evidenceLineIds,
        }, emit),
        ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
      }, binding, input);
      // One event per pass, carrying the counts. A per-line event would be
      // truthful and useless: a thousand-line first ingest would evict the
      // whole bounded stream and take everyone else's events with it.
      //
      // And a pass that produced no durable outcome says nothing, so it says
      // nothing. The pump looks once a second per binding forever; announcing
      // `transcript.line.committed` for `discovered: 0` filled §15's bounded
      // ring with three sentences a second about nothing having happened and
      // pushed every other kind off it — which is exactly what exam row L1
      // read back as "the endpoint, inbox and binding kinds are missing".
      // Emitting only on a real outcome is not a quota: it is the event kind
      // meaning what its name says.
      if (!ingested.ok || !committedSomething(ingested.value)) return ingested;
      // B3d, additively on the SAME kind: which Run and session the pass was
      // for, and the human turns it committed. The counts said a turn arrived
      // without saying which, so no consumer could recognise a turn it had
      // itself caused — Q11's observation is exactly that recognition. Still
      // one event per pass, still this one channel.
      return announce(ingested, 'transcript.line.committed', (value) => ({
        bindingId: value.bindingId,
        agentRunId: binding.agentRunId,
        providerSessionId: binding.providerSessionId,
        discovered: value.discovered,
        filtered: value.filtered,
        mirrored: value.mirrored,
        quarantined: value.quarantined,
        ...(value.nextWatermark === undefined ? {} : { nextWatermark: value.nextWatermark }),
        ...(value.haltedBy === undefined ? {} : { haltedBy: value.haltedBy }),
        ...(value.committedInputLines === undefined
          ? {} : { committedInputLines: value.committedInputLines }),
      }));
    },

    async promoteMirrorWatermark(
      _ctx: SystemCommandContext<'sys_transcript'>, input: PromoteMirrorWatermarkInput,
    ) {
      const binding = await bindingById(input.bindingId);
      if (binding === null) return b3fail(unknownBinding(input.bindingId));
      if (input.expectedWatermark !== binding.mirrorWatermark) {
        return b3fail(b3err('VersionConflict', 'the mirror watermark moved',
          {
            objectId: binding.id,
            expected: input.expectedWatermark ?? null,
            actual: binding.mirrorWatermark ?? null,
          }, true));
      }
      // §13.9's hard stop, restated where it can be enforced: an explicit
      // promotion cannot step over a quarantine either.
      if (binding.sourceDiscoveryState === 'corrupt') {
        return b3fail(b3err('TranscriptCorrupt',
          'the watermark cannot advance past a quarantined position',
          {
            bindingId: binding.id,
            sourcePosition: binding.quarantinedPosition ?? '',
            expectedDigest: '', actualDigest: '',
          }, false));
      }
      // §13.9: "the mirror watermark advances only after a durable filtered
      // outcome or durable Message/effect result." `outcomeRefs` is that
      // sentence as an argument — the outcomes the caller says justify the
      // advance — and nothing read it. So an explicit promotion could push a
      // healthy binding's watermark to any string, and every source position it
      // skipped would never be read again: turns lost silently, with nothing
      // afterwards saying a gap exists. `outcomeRefs: []` is the claim "nothing
      // justifies this", and it was the shape every caller happened to pass.
      const justified = await requireDurableOutcomes(store, binding.id, input);
      if (!justified.ok) return justified;

      return announce(await store.update<TranscriptBinding>(binding.id, {
        mirrorWatermark: input.nextWatermark,
      }, binding.recordVersion, keyFor(`watermark:${binding.id}:${input.nextWatermark}`)),
      bindingEvent, bindingPayload);
    },

    async promoteObservedSubagent(
      _ctx: SystemCommandContext<'sys_transcript'>, input: PromoteObservedSubagentInput,
    ): Promise<B3Result<PromoteObservedSubagentOutcome>> {
      const found = await store.read<ObservedSubagent>(
        'observedSubagent', input.observedSubagentId,
      );
      if (!found.ok) return found;
      if (found.value === null) {
        return b3fail(b3err('ValidationFailed',
          `no observed subagent ${input.observedSubagentId}`,
          { issues: [{ path: 'observedSubagentId', message: 'unknown' }] }, false));
      }
      const subagent = found.value;

      // DEC-B3V4-18: promotion needs provider evidence of identity. No
      // evidence, no promotion — and `observation-only` is a legal outcome,
      // not an error, because the honest answer to "can Novakai control this
      // provider-native subagent?" is often no.
      const missing: string[] = [];
      if (subagent.evidenceLineIds.length === 0) missing.push('evidenceLineIds');
      if (subagent.providerNativeId.trim() === '') missing.push('providerNativeId');
      if (options.promotion === undefined) missing.push('promotion-authority');
      if (missing.length > 0) {
        const marked = await store.update<ObservedSubagent>(subagent.id, {
          status: 'unsupported',
          unsupportedReason: `insufficient evidence: ${missing.join(', ')}`,
        }, subagent.recordVersion, keyFor(`unsupported:${subagent.id}`));
        if (!marked.ok) return marked;
        emit(subagentEvent, subagentPayload(marked.value));
        return b3ok({
          kind: 'observation-only',
          subagent: marked.value,
          reason: 'provider evidence does not support identity or authority',
          missingEvidence: missing,
        });
      }

      const promoted = await options.promotion!.promote({
        observedSubagentId: subagent.id,
        roleProfileId: input.roleProfileId,
        displayName: input.displayName,
        providerNativeId: subagent.providerNativeId,
        evidenceLineIds: subagent.evidenceLineIds,
      });
      if (!promoted.ok) return promoted;

      const updated = await store.update<ObservedSubagent>(subagent.id, {
        status: 'promoted', promotedAgentId: promoted.value.agentId,
      }, subagent.recordVersion, keyFor(`promote:${subagent.id}`));
      if (!updated.ok) return updated;
      emit(subagentEvent, subagentPayload(updated.value));
      return b3ok({
        kind: 'promoted', subagent: updated.value, agentId: promoted.value.agentId,
      });
    },

    async getTranscriptBinding(_principal: AuthenticatedPrincipal, agentRunId: AgentRunId) {
      const bindings = await store.list<TranscriptBinding>('transcriptBinding');
      if (!bindings.ok) return bindings;
      const found = bindings.value.find((binding) => binding.agentRunId === agentRunId);
      if (found === undefined) {
        return b3fail(b3err('UnknownAgentRun',
          `no transcript binding for Run ${agentRunId}`, { agentRunId }, false));
      }
      return b3ok(found);
    },

    async listObservedSubagents(
      _principal: AuthenticatedPrincipal, input: ListObservedSubagentsInput,
    ): Promise<B3Result<Page<ObservedSubagent>>> {
      const observed = await store.list<ObservedSubagent>('observedSubagent');
      if (!observed.ok) return observed;
      let items = [...observed.value];
      if (input.bindingId !== undefined) {
        items = items.filter((item) => item.bindingId === input.bindingId);
      }
      if (input.agentRunId !== undefined) {
        const bindings = await store.list<TranscriptBinding>('transcriptBinding');
        if (!bindings.ok) return bindings;
        const forRun = new Set(bindings.value
          .filter((binding) => binding.agentRunId === input.agentRunId)
          .map((binding) => binding.id));
        items = items.filter((item) => forRun.has(item.bindingId));
      }
      return b3ok({ items: items.slice(0, input.limit) });
    },
  };
}

/**
 * Record a provider-native subagent that was SEEN. Status is always
 * `observed`; nothing here can produce `promoted`, which is the structural
 * form of "observation never silently becomes control".
 */
export async function recordObservedSubagent(
  store: TranscriptStore,
  input: {
    readonly bindingId: TranscriptBindingId;
    readonly providerNativeId: string;
    readonly observedParentNativeId?: string;
    readonly evidenceLineIds: readonly string[];
  },
  emit?: CapabilityEventEmitter,
): Promise<B3Result<ObservedSubagent>> {
  const id = mintObservedSubagentId(
    input.bindingId, input.providerNativeId,
  ) as ObservedSubagentId;
  const existing = await store.read<ObservedSubagent>('observedSubagent', id);
  if (!existing.ok) return existing;
  if (existing.value !== null) return b3ok(existing.value);
  const created = await store.create<ObservedSubagent>({
    kind: 'observedSubagent',
    id,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: 'sys_transcript',
    bindingId: input.bindingId,
    providerNativeId: input.providerNativeId,
    ...(input.observedParentNativeId === undefined
      ? {} : { observedParentNativeId: input.observedParentNativeId }),
    evidenceLineIds: [...input.evidenceLineIds],
    status: 'observed',
  } as never, keyFor(`observe:${id}`));
  if (created.ok) emit?.(subagentEvent, subagentPayload(created.value));
  return created;
}

/**
 * B3c Transcript records — B3V4-P2 §8.2.
 *
 * Two durable facts and one value object:
 *
 *   TranscriptBinding — the custody chain from a Run to the provider file it
 *                       reads, plus how far the mirror has got. Its
 *                       `sourceDiscoveryState` is the reason §25-B3c can say
 *                       "live first bind is explicit": bound / waiting /
 *                       missing / corrupt are four different answers, and
 *                       none of them is silence.
 *   ObservedSubagent  — a provider-native subagent that was SEEN. Its status
 *                       stays `observed` until somebody explicitly promotes
 *                       it, because DEC-B3V4-18 says observation never
 *                       silently becomes control.
 */

import type {
  AgentId as FoundationAgentId, AgentRunId as FoundationAgentRunId,
  ObservedSubagentId as FoundationObservedSubagentId, ProviderSessionId as FoundationProviderSessionId,
  RecordEnvelope, TranscriptBindingId as FoundationTranscriptBindingId,
  TranscriptLineId as FoundationTranscriptLineId,
} from '@novakai/foundation/contract';

export type AgentId = FoundationAgentId;
export type AgentRunId = FoundationAgentRunId;
export type ProviderSessionId = FoundationProviderSessionId;
export type TranscriptBindingId = FoundationTranscriptBindingId;
export type TranscriptLineId = FoundationTranscriptLineId;
export type ObservedSubagentId = FoundationObservedSubagentId;

export type ProviderKind = 'claude' | 'codex' | 'kimi';

/**
 * The four answers to "where is this Run's transcript?".
 *
 * `waiting` is the one that earns its place: a Run that has just started has a
 * provider session but no file on disk yet. Reporting that as `missing` would
 * make every fresh spawn look broken; reporting nothing at all is what §25-B3c
 * calls silent absence.
 */
export type SourceDiscoveryState = 'bound' | 'waiting' | 'missing' | 'corrupt';

export type WatcherState = 'live' | 'stopped' | 'recovery-required';

export interface TranscriptBinding
  extends RecordEnvelope<TranscriptBindingId, 'transcriptBinding'> {
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly provider: ProviderKind;
  readonly providerSessionId: ProviderSessionId;
  readonly sourceLocatorDigest: string;
  readonly sourceDiscoveryState: SourceDiscoveryState;
  /** The last source position whose outcome is durable. Never advances over quarantine. */
  readonly mirrorWatermark?: string;
  readonly watcherState: WatcherState;
  /** Where mirrored Messages land. One conversation, one Thread. */
  readonly threadId: string;
  /** Set when the source went corrupt: the position that conflicted. */
  readonly quarantinedPosition?: string;
}

export interface NormalisedTranscriptTurn {
  readonly transcriptLineId: TranscriptLineId;
  readonly bindingId: TranscriptBindingId;
  readonly sourcePosition: string;
  readonly role: 'human' | 'assistant';
  readonly text: string;
  readonly occurredAt?: string;
  readonly sourceDigest: string;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export type ObservedSubagentStatus = 'observed' | 'promoted' | 'unsupported';

export interface ObservedSubagent
  extends RecordEnvelope<ObservedSubagentId, 'observedSubagent'> {
  readonly bindingId: TranscriptBindingId;
  readonly providerNativeId: string;
  readonly observedParentNativeId?: string;
  /** The lines that prove this subagent was seen. Promotion needs evidence. */
  readonly evidenceLineIds: readonly TranscriptLineId[];
  readonly status: ObservedSubagentStatus;
  readonly promotedAgentId?: AgentId;
  /** Recorded when promotion was refused, so the refusal is inspectable. */
  readonly unsupportedReason?: string;
}

/* eslint-disable id-length -- Row-oriented names mirror provider-native JSONL records. */
/* eslint-disable max-lines -- Exact-version provider parsers share one conformance boundary. */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  deterministicId,
  providerTurnBoundaryProfileId,
  type IsoUtc,
  type TranscriptLineId,
} from '@novakai/foundation/contract';
import type {
  ProviderTurnBoundaryInput,
  ProviderTurnBoundaryObservation,
  ProviderTurnBoundaryProfile,
} from '../../contract/providers.js';
import type { ProviderKind } from '../../contract/records.js';

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const positionOf = (ordinal: number): string => String(ordinal).padStart(10, '0');

/** Exact executable versions whose native source schemas are conformance-tested here. */
export const SUPPORTED_PROVIDER_BOUNDARY_VERSIONS: Readonly<Record<ProviderKind, string>> = {
  claude: '2.1.219 (Claude Code)',
  codex: 'codex-cli 0.146.0',
  kimi: '0.31.1',
};

const profilePayload = (
  provider: ProviderKind, executableVersion: string,
): Omit<ProviderTurnBoundaryProfile, 'id'> => ({
  provider,
  executableVersion,
  sourceFormatSchemaDigest: sha256(canonicalJson([
    'b3v4-provider-turn-source-schema', provider, executableVersion,
  ])),
  inputFrame: {
    discriminatorPath: '/frame/type',
    discriminatorValue: `${provider}-provider-turn`,
    logicalUtf8TextPath: '/frame/logicalUtf8Text',
    providerNativeSessionIdPath: '/frame/sessionId',
  },
  completionFrame: {
    discriminatorPath: '/frame/type',
    terminalDiscriminatorValues: [`${provider}-provider-turn`],
    providerNativeSessionIdPath: '/frame/sessionId',
    terminalSemanticsEvidenceDigest: sha256(canonicalJson([
      'b3v4-provider-terminal-semantics', provider, executableVersion,
      provider === 'claude' ? 'assistant.message.stop_reason=end_turn'
        : provider === 'codex' ? 'event_msg.payload.type=task_complete'
          : 'context.append_loop_event.event.type=step.end;finishReason=end_turn',
    ])),
  },
  correlation: {
    mode: 'explicit-response-envelope',
    correlationIdPath: '/frame/correlationId',
    phasePath: '/frame/phase',
    inputStartPhaseValue: 'input-start',
    completionTerminalPhaseValue: 'completion-terminal',
  },
  ordering: {
    mode: 'strict-monotonic-source-position',
    intermediateToolFramesMustShareCorrelation: true,
    sourceGapInvalidatesProof: true,
  },
  evidenceDigestRecipe: 'sha256(canonical-json(profileId,providerNativeSessionId,providerNativeTurnIdOrCorrelationId,inputPosition,completionPosition,inputSourceDigest,completionSourceDigest,orderedIntermediateSourceDigests))',
});

export function boundaryProfile(
  provider: ProviderKind,
  executableVersion: string,
): ProviderTurnBoundaryProfile {
  const payload = profilePayload(provider, executableVersion);
  return { id: providerTurnBoundaryProfileId(canonicalJson(payload)), ...payload };
}

export function productionBoundaryProfile(
  provider: ProviderKind,
  executableVersion: string,
): ProviderTurnBoundaryProfile | null {
  return SUPPORTED_PROVIDER_BOUNDARY_VERSIONS[provider] === executableVersion
    ? boundaryProfile(provider, executableVersion)
    : null;
}

export function boundaryProfileValid(profile: ProviderTurnBoundaryProfile): boolean {
  if (profile.executableVersion.trim() === '') return false;
  const expected = providerTurnBoundaryProfileId(canonicalJson(
    profilePayload(profile.provider, profile.executableVersion),
  ));
  if (expected !== profile.id) return false;
  if (profile.correlation.mode === 'shared-provider-native-turn-id') {
    return profile.inputFrame.providerNativeTurnIdPath !== undefined
      && profile.completionFrame.providerNativeTurnIdPath !== undefined
      && !profile.completionFrame.terminalDiscriminatorValues.includes(
        profile.inputFrame.discriminatorValue,
      );
  }
  return profile.correlation.correlationIdPath.startsWith('/')
    && profile.correlation.phasePath.startsWith('/')
    && profile.correlation.inputStartPhaseValue !== profile.correlation.completionTerminalPhaseValue;
}

interface SourceRow {
  readonly position: string;
  readonly raw: string;
  readonly digest: string;
  readonly value: Record<string, unknown> | null;
}

interface BoundaryMatch {
  readonly correlationId: string;
  readonly input: SourceRow;
  readonly completion: SourceRow;
  readonly rows: readonly SourceRow[];
  readonly committedAt: IsoUtc;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const textAt = (value: Record<string, unknown>, key: string): string | null =>
  typeof value[key] === 'string' ? value[key] as string : null;

function rowsOf(contents: string): readonly SourceRow[] {
  return contents.split('\n').flatMap((raw, ordinal) => {
    if (raw.trim() === '') return [];
    let value: Record<string, unknown> | null = null;
    try { value = object(JSON.parse(raw)); } catch { /* source gap */ }
    return [{ position: positionOf(ordinal), raw, digest: sha256(raw), value }];
  });
}

function logicalText(parts: unknown): string | null {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return null;
  const text = parts.flatMap((part) => {
    const item = object(part);
    if (item === null || (item.type !== 'text' && item.type !== 'input_text')) return [];
    return typeof item.text === 'string' ? [item.text] : [];
  }).join('');
  return text === '' ? null : text;
}

function timeOf(row: SourceRow): IsoUtc | null {
  const value = row.value;
  if (value === null) return null;
  if (typeof value.timestamp === 'string' && !Number.isNaN(Date.parse(value.timestamp))) {
    return new Date(value.timestamp).toISOString() as IsoUtc;
  }
  if (typeof value.time === 'number' && Number.isFinite(value.time)) {
    return new Date(value.time).toISOString() as IsoUtc;
  }
  return null;
}

function sourceLineId(bindingId: string, position: string): TranscriptLineId {
  return `transcriptLine_${createHash('sha256')
    .update(`b3v4\u001f${bindingId}\u001f${position}`, 'utf8')
    .digest('hex')}` as TranscriptLineId;
}

/** Row types Claude Code links into the conversation chain; every other type is noise. */
const CLAUDE_CHAIN_TYPES: readonly string[] = ['user', 'assistant'];

/**
 * Claude Code records a tool result as a user-ROLE row:
 * `{"type":"user","message":{"role":"user","content":[{"type":"tool_result",...}]}}`.
 * Only a user-role row whose content is a string, or an array carrying no
 * `tool_result` part, is a genuine new human turn — that is the one frame allowed
 * to open or close a completion window.
 */
function claudeHumanTurn(value: Record<string, unknown>): boolean {
  const message = object(value.message);
  if (value.type !== 'user' || message?.role !== 'user') return false;
  const content = message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content)
    && !content.some((part) => object(part)?.type === 'tool_result');
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Exact native-frame state machine.
function claudeMatch(
  rows: readonly SourceRow[], input: ProviderTurnBoundaryInput,
): BoundaryMatch | 'input-ambiguous' | 'end-ambiguous' | 'source-gap' | null {
  if (rows.some((row) => row.value === null)) return 'source-gap';
  const candidates = rows.filter((row) => {
    const value = row.value!;
    const message = object(value.message);
    return claudeHumanTurn(value)
      && value.sessionId === input.providerNativeSessionId
      && sha256(logicalText(message?.content) ?? '') === input.inputDigest;
  });
  // Identical prompt text repeats within one session; source position disambiguates.
  // `rows` is already clipped to the submission's watermark window, so the first
  // candidate is the first genuine human turn after startTranscriptWatermark.
  const start = candidates[0];
  if (start === undefined) return null;
  const startIndex = rows.indexOf(start);
  const root = textAt(start.value!, 'uuid');
  if (root === null) return 'source-gap';
  const correlated = new Set([root]);
  const skipped = new Set<string>();
  const toolCalls = new Set<string>();
  const terminals: SourceRow[] = [];
  const evidence: SourceRow[] = [start];
  for (const row of rows.slice(startIndex + 1)) {
    const value = row.value!;
    const message = object(value.message);
    if (claudeHumanTurn(value)) break;
    const parent = textAt(value, 'parentUuid');
    const uuid = textAt(value, 'uuid');
    if (uuid === null) continue;
    // Attachment/system/summary/snapshot rows carry a uuid and a null parentUuid
    // without joining the chain. They are interleaved noise, not corruption.
    if (typeof value.type !== 'string' || !CLAUDE_CHAIN_TYPES.includes(value.type)) {
      skipped.add(uuid);
      continue;
    }
    if (parent === null || !(correlated.has(parent) || skipped.has(parent))) {
      return 'end-ambiguous';
    }
    correlated.add(uuid);
    evidence.push(row);
    if (message !== null && Array.isArray(message.content)) {
      for (const part of message.content) {
        const item = object(part);
        if (item?.type === 'tool_use' && typeof item.id === 'string') toolCalls.add(item.id);
        if (item?.type === 'tool_result'
          && (typeof item.tool_use_id !== 'string' || !toolCalls.has(item.tool_use_id))) {
          return 'source-gap';
        }
      }
    }
    if (value.type === 'assistant' && message?.role === 'assistant'
      && message.stop_reason === 'end_turn') terminals.push(row);
  }
  // A turn may stop more than once before the next human prompt; the turn ends at
  // the last terminal frame in its correlated chain.
  const completion = terminals[terminals.length - 1];
  if (completion === undefined) return null;
  const committedAt = timeOf(completion);
  if (committedAt === null) return 'source-gap';
  return {
    correlationId: root, input: start, completion,
    rows: evidence.slice(0, evidence.indexOf(completion) + 1), committedAt,
  };
}

function codexInputText(value: Record<string, unknown>): string | null {
  const payload = object(value.payload);
  return value.type === 'response_item' && payload?.type === 'message' && payload.role === 'user'
    ? logicalText(payload.content)
    : null;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Exact native-frame state machine.
function codexMatch(
  rows: readonly SourceRow[], input: ProviderTurnBoundaryInput,
): BoundaryMatch | 'input-ambiguous' | 'end-ambiguous' | 'source-gap' | null {
  if (rows.some((row) => row.value === null)) return 'source-gap';
  const candidates: Array<{ row: SourceRow; correlationId: string; startedAt: number }> = [];
  let matchingInputCount = 0;
  let active: { id: string; index: number } | null = null;
  for (const [index, row] of rows.entries()) {
    const value = row.value!;
    const payload = object(value.payload);
    if (value.type === 'event_msg' && payload?.type === 'task_started'
      && typeof payload.turn_id === 'string') active = { id: payload.turn_id, index };
    const text = codexInputText(value);
    if (text !== null && sha256(text) === input.inputDigest) {
      matchingInputCount += 1;
      if (active !== null) {
        candidates.push({ row, correlationId: active.id, startedAt: active.index });
      }
    }
  }
  if (matchingInputCount > 1 || candidates.length > 1) return 'input-ambiguous';
  if (candidates.length === 0) return null;
  const candidate = candidates[0]!;
  const inputIndex = rows.indexOf(candidate.row);
  const toolCalls = new Set<string>();
  const terminals: SourceRow[] = [];
  const evidence = rows.slice(candidate.startedAt, inputIndex + 1) as SourceRow[];
  for (const row of rows.slice(inputIndex + 1)) {
    const value = row.value!;
    const payload = object(value.payload);
    if (value.type === 'event_msg' && payload?.type === 'task_started') break;
    evidence.push(row);
    if (value.type === 'response_item'
      && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')
      && typeof payload.call_id === 'string') toolCalls.add(payload.call_id);
    if (value.type === 'response_item'
      && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')
      && (typeof payload.call_id !== 'string' || !toolCalls.has(payload.call_id))) {
      return 'source-gap';
    }
    if (value.type === 'event_msg' && payload?.type === 'task_complete') {
      if (payload.turn_id === candidate.correlationId) terminals.push(row);
      else return 'end-ambiguous';
    }
  }
  if (terminals.length !== 1) return terminals.length === 0 ? null : 'end-ambiguous';
  const completion = terminals[0]!;
  const committedAt = timeOf(completion);
  if (committedAt === null) return 'source-gap';
  return {
    correlationId: candidate.correlationId, input: candidate.row, completion,
    rows: evidence.slice(0, evidence.indexOf(completion) + 1), committedAt,
  };
}

function kimiPromptText(value: Record<string, unknown>): string | null {
  return value.type === 'turn.prompt' ? logicalText(value.input) : null;
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Exact native-frame state machine.
function kimiMatch(
  rows: readonly SourceRow[], input: ProviderTurnBoundaryInput,
): BoundaryMatch | 'input-ambiguous' | 'end-ambiguous' | 'source-gap' | null {
  if (rows.some((row) => row.value === null)) return 'source-gap';
  const candidates = rows.filter((row) => {
    const text = kimiPromptText(row.value!);
    return text !== null && sha256(text) === input.inputDigest;
  });
  if (candidates.length !== 1) return candidates.length === 0 ? null : 'input-ambiguous';
  const start = candidates[0]!;
  const startIndex = rows.indexOf(start);
  let correlationId: string | null = null;
  const terminals: SourceRow[] = [];
  const evidence: SourceRow[] = [start];
  for (const row of rows.slice(startIndex + 1)) {
    const value = row.value!;
    if (value.type === 'turn.prompt') break;
    if (value.type !== 'context.append_loop_event') continue;
    const event = object(value.event);
    if (event === null || typeof event.type !== 'string') return 'source-gap';
    if (event.type === 'step.begin' && correlationId === null) {
      if (typeof event.turnId !== 'string' || event.turnId === '') return 'source-gap';
      correlationId = event.turnId;
    }
    if (correlationId === null || event.turnId !== correlationId) return 'end-ambiguous';
    evidence.push(row);
    if (event.type === 'step.end' && event.finishReason === 'end_turn') terminals.push(row);
  }
  if (correlationId === null) return null;
  if (terminals.length !== 1) return terminals.length === 0 ? null : 'end-ambiguous';
  const completion = terminals[0]!;
  const committedAt = timeOf(completion);
  if (committedAt === null) return 'source-gap';
  return {
    correlationId, input: start, completion,
    rows: evidence.slice(0, evidence.indexOf(completion) + 1), committedAt,
  };
}

export function observeProviderBoundarySource(
  profile: ProviderTurnBoundaryProfile,
  input: ProviderTurnBoundaryInput,
  contents: string,
): ProviderTurnBoundaryObservation {
  if (!boundaryProfileValid(profile)) {
    return {
      kind: 'uncertain', reason: 'provider-version-unsupported', evidenceRefs: [profile.id],
    };
  }
  if (input.currentTranscriptWatermark === null) {
    return { kind: 'unavailable', reason: 'source-unavailable', evidenceRefs: [] };
  }
  const visible = rowsOf(contents).filter((row) =>
    (input.startTranscriptWatermark === null || row.position > input.startTranscriptWatermark)
    && row.position <= input.currentTranscriptWatermark!);
  const matched = profile.provider === 'claude'
    ? claudeMatch(visible, input)
    : profile.provider === 'codex'
      ? codexMatch(visible, input)
      : kimiMatch(visible, input);
  if (matched === null) {
    return { kind: 'unavailable', reason: 'source-unavailable', evidenceRefs: [] };
  }
  if (matched === 'source-gap') {
    return { kind: 'uncertain', reason: 'source-gap', evidenceRefs: [] };
  }
  if (matched === 'input-ambiguous') {
    return { kind: 'uncertain', reason: 'input-frame-ambiguous', evidenceRefs: [] };
  }
  if (matched === 'end-ambiguous') {
    return { kind: 'uncertain', reason: 'end-frame-ambiguous', evidenceRefs: [] };
  }
  const digests = matched.rows.map((row) => row.digest);
  const framingEvidenceDigest = sha256(canonicalJson([
    profile.id,
    input.providerNativeSessionId,
    matched.correlationId,
    matched.input.position,
    matched.completion.position,
    matched.input.digest,
    matched.completion.digest,
    digests.slice(1, -1),
  ]));
  return {
    kind: 'proven',
    providerCorrelationId: matched.correlationId,
    providerNativeTurnId: matched.correlationId,
    submittedInputSourcePosition: matched.input.position,
    completionSourcePosition: matched.completion.position,
    completionSourceCommittedAt: matched.committedAt,
    submittedInputEvidenceDigest: input.inputDigest,
    sourceLineIds: matched.rows.map((row) =>
      sourceLineId(input.transcriptBindingId, row.position)) as [TranscriptLineId, ...TranscriptLineId[]],
    resultingWatermark: matched.completion.position,
    turnBoundaryProfileId: profile.id,
    framingEvidenceDigest,
    limitations: [],
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- Bounded provider-specific source discovery.
function walkForNative(
  root: string, nativeId: string, provider: ProviderKind, depth = 0,
): string | null {
  if (depth > 6 || !existsSync(root)) return null;
  let entries: readonly string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(root, entry);
    let directory = false;
    try {
      directory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (directory) {
      if (provider === 'kimi' && entry === `session_${nativeId}`) {
        const wire = path.join(full, 'agents', 'main', 'wire.jsonl');
        if (existsSync(wire)) return wire;
      }
      const nested = walkForNative(full, nativeId, provider, depth + 1);
      if (nested !== null) return nested;
    } else if (provider !== 'kimi' && entry.endsWith('.jsonl') && entry.includes(nativeId)) {
      return full;
    }
  }
  return null;
}

export function observeProviderBoundaryFile(
  profile: ProviderTurnBoundaryProfile,
  sourceRoot: string,
  input: ProviderTurnBoundaryInput,
): ProviderTurnBoundaryObservation {
  const file = walkForNative(sourceRoot, input.providerNativeSessionId, profile.provider);
  if (file === null) {
    return { kind: 'unavailable', reason: 'source-unavailable', evidenceRefs: [] };
  }
  try {
    return observeProviderBoundarySource(profile, input, readFileSync(file, 'utf8'));
  } catch {
    return { kind: 'unavailable', reason: 'source-unavailable', evidenceRefs: [sha256(file)] };
  }
}

/** Deterministic native framing used only by the synthetic provider adapter. */
export function fakeBoundaryObservation(
  profile: ProviderTurnBoundaryProfile,
  input: ProviderTurnBoundaryInput,
): ProviderTurnBoundaryObservation {
  const correlation = `fake-native-turn:${input.providerTurnId}`;
  const submittedInputSourcePosition = `fake:${input.providerTurnId}:input`;
  const completionSourcePosition = `fake:${input.providerTurnId}:completed`;
  const framingEvidenceDigest = deterministicId('evidence', [
    profile.id,
    input.providerNativeSessionId,
    correlation,
    submittedInputSourcePosition,
    completionSourcePosition,
    input.inputDigest,
  ]).slice('evidence_'.length);
  return {
    kind: 'proven',
    providerCorrelationId: correlation,
    providerNativeTurnId: correlation,
    submittedInputSourcePosition,
    completionSourcePosition,
    completionSourceCommittedAt: '2026-08-03T00:00:00.000Z' as IsoUtc,
    submittedInputEvidenceDigest: input.inputDigest,
    sourceLineIds: [deterministicId('transcriptLine', [
      input.transcriptBindingId, correlation,
    ]) as TranscriptLineId],
    resultingWatermark: completionSourcePosition,
    turnBoundaryProfileId: profile.id,
    framingEvidenceDigest,
    limitations: [],
  };
}

export const unavailableBoundary = (): ProviderTurnBoundaryObservation => ({
  kind: 'unavailable',
  reason: 'source-unavailable',
  evidenceRefs: ['provider source must be observed by Transcript'],
});

import type {
  NormalizedProviderLine,
  ProviderNormalizer,
} from '../../../contract/ports/provider-transcript-source.js';
import type { TranscriptRole } from '../../../contract/types.js';
import { findAgentIdentityMarker } from '../../../contract/agent-identity.js';
import { present } from '../../../core/sparse.js';
import {
  contentText,
  declaredRole,
  displayUserText,
  isObject,
  jsonText,
  noise,
  numericUsage,
  parseExtent,
  textValue,
  userCorrelation,
  type JsonObject,
} from './support.js';

type AgentIdentity = NonNullable<ReturnType<typeof findAgentIdentityMarker>>;

/** The identity marker line: internal bookkeeping only. */
const hookLine = (agentIdentity: AgentIdentity): NormalizedProviderLine => ({
  role: 'hook',
  text: JSON.stringify(agentIdentity),
  audience: 'internal',
  agentIdentity,
});

/** A raw input row is user-originated but not renderable prose. */
const inputLine = (input: unknown): NormalizedProviderLine => ({
  role: 'user',
  text: jsonText(input),
  audience: 'internal',
});

/** A kimi user message counts as conversation only when its origin says user. */
const kimiConversational = (
  role: TranscriptRole,
  origin: JsonObject | undefined,
  normalizedText: string,
): boolean =>
  (role === 'assistant' || (role === 'user' && textValue(origin?.kind) === 'user'))
  && normalizedText.trim() !== '';

const kimiMessageRole = (message: JsonObject): TranscriptRole =>
  declaredRole(message.role) ?? 'system';

/** One kimi message row in the provider-neutral vocabulary. */
function messageLine(message: JsonObject): NormalizedProviderLine {
  const role = kimiMessageRole(message);
  const origin = isObject(message.origin) ? message.origin : undefined;
  const normalized = contentText(message.content) ?? jsonText(message.content);
  const audience: NormalizedProviderLine['audience'] = kimiConversational(role, origin, normalized)
    ? 'conversation'
    : 'internal';
  const text = role === 'user' ? displayUserText(normalized) : normalized;
  return {
    role,
    text,
    audience,
    ...present('correlationHint', userCorrelation(role, audience, text)),
    ...present('providerLineId', textValue(message.id)),
  };
}

/** Wire tool events name their role; text parts are assistant prose. */
const wireToolRole = (eventType: string | undefined): TranscriptRole | undefined => {
  if (eventType === 'tool.call') return 'tool_call';
  return eventType === 'tool.result' ? 'tool_result' : undefined;
};

const wireContentRole = (eventType: string | undefined, partType: unknown): TranscriptRole =>
  eventType === 'content.part' && partType === 'text' ? 'assistant' : 'system';

const wireRole = (eventType: string | undefined, partType: unknown): TranscriptRole =>
  wireToolRole(eventType) ?? wireContentRole(eventType, partType);

/** Wire tool payloads stay structured; parts contribute their text or think field. */
const wireText = (
  role: TranscriptRole,
  event: JsonObject,
  part: JsonObject | undefined,
): string => {
  if (role === 'tool_call') return jsonText({ name: event.name, args: event.args });
  if (role === 'tool_result') return jsonText(event.result);
  return textValue(part?.text) ?? textValue(part?.think) ?? '';
};

const wireToolCall = (role: TranscriptRole, event: JsonObject): JsonObject | undefined =>
  role === 'tool_call' ? event : undefined;

/** One wire-format loop event in the provider-neutral vocabulary. */
function wireEventLine(event: JsonObject): NormalizedProviderLine {
  const eventType = textValue(event.type);
  const part = isObject(event.part) ? event.part : undefined;
  const role = wireRole(eventType, part?.type);
  const text = wireText(role, event, part);
  const audience: NormalizedProviderLine['audience'] = role === 'assistant' && text.trim() !== ''
    ? 'conversation'
    : 'internal';
  return {
    role,
    text,
    audience,
    ...present('providerLineId', textValue(event.uuid)),
    ...present('turnId', textValue(event.turnId)),
    ...present('tokenUsage', numericUsage(event.usage)),
    ...present('toolCall', wireToolCall(role, event)),
  };
}

/** Native tool and attachment events name their role; the rest defer to the message. */
const nativeEventRole = (eventType: string | undefined): TranscriptRole | undefined => {
  if (eventType === 'tool.call.started') return 'tool_call';
  if (eventType === 'tool.result') return 'tool_result';
  return eventType === 'attachment' ? 'attachment' : undefined;
};

const nativeRole = (
  eventType: string | undefined,
  message: JsonObject | undefined,
): TranscriptRole =>
  nativeEventRole(eventType) ?? declaredRole(message?.role) ?? 'assistant';

const toolResultText = (payload: JsonObject): string =>
  textValue(payload.output) ?? jsonText(payload.message);

/** Native structured roles keep their structure; prose roles fall back through the payload. */
const nativeText = (
  role: TranscriptRole,
  payload: JsonObject,
  message: JsonObject | undefined,
): string => {
  if (role === 'tool_call') return jsonText({ name: payload.name, args: payload.args });
  if (role === 'tool_result') return toolResultText(payload);
  if (role === 'attachment') return jsonText(message?.content ?? payload);
  return nativeProseText(payload, message);
};

const payloadText = (payload: JsonObject): string | undefined =>
  textValue(payload.output) ?? textValue(payload.prompt);

const messageText = (message: JsonObject | undefined): string | undefined =>
  contentText(message?.content) ?? textValue(message?.content);

const nativeProseText = (payload: JsonObject, message: JsonObject | undefined): string =>
  payloadText(payload) ?? messageText(message) ?? '';

/** Native rows are conversation when the embedded message is user or assistant. */
const nativeAudience = (
  message: JsonObject | undefined,
): NormalizedProviderLine['audience'] =>
  message?.role === 'user' || message?.role === 'assistant' ? 'conversation' : 'internal';

/** The envelope's sequence wins; the read order is the fallback. */
const turnSequenceOf = (envelope: JsonObject, turnIndex: number): number =>
  Number.isInteger(envelope.seq) ? Number(envelope.seq) : turnIndex;

const kimiTurnId = (envelope: JsonObject, payload: JsonObject, turnIndex: number): string =>
  textValue(payload.turnId) ?? `kimi-turn-${turnSequenceOf(envelope, turnIndex)}`;

const kimiResumeId = (envelope: JsonObject, payload: JsonObject): string | undefined =>
  textValue(payload.sessionId) ?? textValue(envelope.session_id);

const kimiToolCall = (role: TranscriptRole, payload: JsonObject): JsonObject | undefined =>
  role === 'tool_call' ? payload : undefined;

/** One native envelope's payload in the provider-neutral vocabulary. */
function nativeLine(
  envelope: JsonObject,
  payload: JsonObject,
  turnIndex: number,
): NormalizedProviderLine {
  const message = isObject(payload.message) ? payload.message : undefined;
  const eventType = textValue(envelope.type) ?? textValue(payload.type);
  const role = nativeRole(eventType, message);
  const text = nativeText(role, payload, message);
  const audience = nativeAudience(message);
  return {
    role,
    text,
    audience,
    turnId: kimiTurnId(envelope, payload, turnIndex),
    ...present('correlationHint', userCorrelation(role, audience, text)),
    ...present('providerLineId', textValue(envelope.id)),
    ...present('resumeId', kimiResumeId(envelope, payload)),
    ...present('parentTurnId', textValue(payload.parentTurnId)),
    ...present('tokenUsage', numericUsage(payload.usage)),
    ...present('toolCall', kimiToolCall(role, payload)),
  };
}

/** One native envelope row, or noise when it carries no payload. */
function nativeEventLine(envelope: JsonObject, turnIndex: number): NormalizedProviderLine {
  if (!isObject(envelope.payload)) return noise();
  return nativeLine(envelope, envelope.payload, turnIndex);
}

/** A loop-event row unwraps to its wire event; anything else is undecided here. */
const loopEventLine = (record: JsonObject): NormalizedProviderLine | undefined =>
  record.type === 'context.append_loop_event' && isObject(record.event)
    ? wireEventLine(record.event)
    : undefined;

/** Message, input, and loop-event rows each have their own shape. */
function specialLine(record: JsonObject): NormalizedProviderLine | undefined {
  if (isObject(record.message)) return messageLine(record.message);
  if (record.input !== undefined) return inputLine(record.input);
  return loopEventLine(record);
}

/** An event-kind row unwraps to its native envelope; anything else is noise. */
const envelopeLine = (record: JsonObject, turnIndex: number): NormalizedProviderLine =>
  record.kind === 'event' && isObject(record.envelope)
    ? nativeEventLine(record.envelope, turnIndex)
    : noise();

/** Kimi wire/event JSONL to the provider-neutral TranscriptLine vocabulary. */
export const kimiNormalizer: ProviderNormalizer = {
  provider: 'kimi',
  normalize(extent, turnIndex) {
    const record = parseExtent(extent);
    if (record === null) return noise();
    const agentIdentity = findAgentIdentityMarker(record);
    if (agentIdentity !== undefined) return hookLine(agentIdentity);
    return specialLine(record) ?? envelopeLine(record, turnIndex);
  },
};

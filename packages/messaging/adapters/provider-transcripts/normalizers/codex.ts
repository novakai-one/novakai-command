import type {
  NormalizedProviderLine,
  ProviderNormalizer,
} from '../../../contract/ports/provider-transcript-source.js';
import type { TranscriptRole } from '../../../contract/types.js';
import { findAgentIdentityMarker } from '../../../contract/agent-identity.js';
import { present } from '../../../core/sparse.js';
import {
  contentText,
  conversational,
  declaredRole,
  displayUserText,
  isObject,
  jsonText,
  noise,
  numericUsage,
  parseExtent,
  textValue,
  toolCallPayload,
  userCorrelation,
  type JsonObject,
} from './support.js';

type AgentIdentity = NonNullable<ReturnType<typeof findAgentIdentityMarker>>;

const TOOL_CALL_EVENTS: readonly string[] = ['function_call', 'custom_tool_call', 'web_search_call'];
const TOOL_RESULT_EVENTS: readonly string[] = ['function_call_output', 'custom_tool_call_output'];
const ATTACHMENT_CONTENT_TYPES: readonly string[] = ['input_image', 'input_file', 'attachment'];
const HARNESS_PREFIXES: readonly string[] = [
  '<recommended_plugins>',
  '# AGENTS.md instructions',
  '<environment_context>',
  '<app-context>',
  '<skills_instructions>',
  '<permissions instructions>',
  '<collaboration_mode>',
];

const hasEvent = (events: readonly string[], eventType: string | undefined): boolean =>
  eventType !== undefined && events.includes(eventType);

/** event_msg rows carry the conversational roles directly. */
const eventMessageRole = (eventType: string | undefined): TranscriptRole => {
  if (eventType === 'user_message') return 'user';
  return eventType === 'agent_message' ? 'assistant' : 'system';
};

/** Structured wire events name their role; anything else is undecided here. */
const eventRole = (rowType: unknown, eventType: string | undefined): TranscriptRole | undefined => {
  if (rowType === 'event_msg') return eventMessageRole(eventType);
  if (hasEvent(TOOL_CALL_EVENTS, eventType)) return 'tool_call';
  return hasEvent(TOOL_RESULT_EVENTS, eventType) ? 'tool_result' : undefined;
};

const attachmentContent = (contentTypes: ReadonlySet<string | undefined>): boolean =>
  [...contentTypes].some((type) => type !== undefined && ATTACHMENT_CONTENT_TYPES.includes(type));

/** Codex calls its system persona 'developer'; everything else uses the shared vocabulary. */
const declaredFallback = (declared: unknown): TranscriptRole =>
  declared === 'developer' ? 'system' : declaredRole(declared) ?? 'system';

function codexRole(
  rowType: unknown,
  eventType: string | undefined,
  declared: unknown,
  contentTypes: ReadonlySet<string | undefined>,
): TranscriptRole {
  const fromEvent = eventRole(rowType, eventType);
  if (fromEvent !== undefined) return fromEvent;
  if (attachmentContent(contentTypes)) return 'attachment';
  return declaredFallback(declared);
}

/** Tool payloads stay structured; everything else is prose. */
const codexText = (
  role: TranscriptRole,
  eventType: string | undefined,
  payload: JsonObject,
): string => {
  if (role === 'tool_call') {
    return jsonText({ type: eventType, name: payload.name, arguments: payload.arguments });
  }
  if (role === 'tool_result') return jsonText({ type: eventType, output: payload.output });
  if (role === 'attachment') return jsonText(payload.content);
  return contentText(payload.content) ?? textValue(payload.message) ?? '';
};

/** Harness-injected content is bookkeeping, never rendered conversation. */
const isHarnessPrefix = (text: string): boolean =>
  HARNESS_PREFIXES.some((prefix) => text.startsWith(prefix));

const harnessContent = (content: readonly JsonObject[]): boolean =>
  content.some((part) => {
    const text = textValue(part.text);
    return text !== undefined && isHarnessPrefix(text);
  });

/** Only response_item messages with host metadata can be rendered conversation. */
const responseMessage = (
  record: JsonObject,
  eventType: string | undefined,
  metadata: JsonObject | undefined,
): boolean =>
  record.type === 'response_item' && eventType === 'message' && metadata !== undefined;

const codexAudience = (
  record: JsonObject,
  eventType: string | undefined,
  metadata: JsonObject | undefined,
  role: TranscriptRole,
  text: string,
  content: readonly JsonObject[],
): NormalizedProviderLine['audience'] =>
  responseMessage(record, eventType, metadata) && conversational(role, text) && !harnessContent(content)
    ? 'conversation'
    : 'internal';

const contentParts = (payload: JsonObject): readonly JsonObject[] =>
  Array.isArray(payload.content) ? payload.content.filter(isObject) : [];

const metadataPassthrough = (payload: JsonObject): JsonObject | undefined =>
  isObject(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;

/** A turn id from the payload, its metadata, or — last resort — the read order. */
const codexTurnId = (
  payload: JsonObject,
  metadata: JsonObject | undefined,
  turnIndex: number,
): string =>
  textValue(payload.turn_id)
  ?? textValue(metadata?.turn_id)
  ?? textValue(payload.id)
  ?? `codex-turn-${turnIndex}`;

/** Tool calls have no id of their own; the call id names the line instead. */
const syntheticLineId = (
  record: JsonObject,
  eventType: string | undefined,
  payload: JsonObject,
): string | undefined => {
  const callId = textValue(payload.call_id);
  if (callId === undefined) return undefined;
  return `${textValue(record.type) ?? 'row'}:${eventType ?? 'event'}:${callId}`;
};

const codexLineId = (
  record: JsonObject,
  eventType: string | undefined,
  payload: JsonObject,
): string | undefined =>
  textValue(payload.id) ?? syntheticLineId(record, eventType, payload);

/** session_meta rows only carry the resume id forward. */
const sessionMetaLine = (record: JsonObject): NormalizedProviderLine =>
  noise(isObject(record.payload) ? textValue(record.payload.id) : undefined);

/** One Codex payload in the provider-neutral vocabulary. */
function codexLine(
  record: JsonObject,
  payload: JsonObject,
  turnIndex: number,
): NormalizedProviderLine {
  const agentIdentity = findAgentIdentityMarker(record);
  const eventType = textValue(payload.type);
  const content = contentParts(payload);
  const contentTypes = new Set(content.map((part) => textValue(part.type)));
  const role = agentIdentity === undefined
    ? codexRole(record.type, eventType, payload.role, contentTypes)
    : 'hook';
  const normalized = codexText(role, eventType, payload);
  const text = role === 'user' ? displayUserText(normalized) : normalized;
  const metadata = metadataPassthrough(payload);
  const audience = codexAudience(record, eventType, metadata, role, text, content);
  return {
    role,
    text,
    audience,
    turnId: codexTurnId(payload, metadata, turnIndex),
    ...present('providerLineId', codexLineId(record, eventType, payload)),
    ...present('tokenUsage', numericUsage(payload.usage)),
    ...present('providerOccurredAt', textValue(record.timestamp)),
    ...present('correlationHint', userCorrelation(role, audience, text)),
    ...present('toolCall', toolCallPayload(role, payload)),
    ...present('agentIdentity', agentIdentity),
  };
}

/** Codex rollout JSONL to the provider-neutral TranscriptLine vocabulary. */
export const codexNormalizer: ProviderNormalizer = {
  provider: 'codex',
  normalize(extent, turnIndex) {
    const record = parseExtent(extent);
    if (record === null) return noise();
    if (record.type === 'session_meta') return sessionMetaLine(record);
    if (!isObject(record.payload)) return noise();
    return codexLine(record, record.payload, turnIndex);
  },
};

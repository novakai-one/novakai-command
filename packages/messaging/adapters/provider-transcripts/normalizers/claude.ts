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
  userCorrelation,
  type JsonObject,
} from './support.js';

type AgentIdentity = NonNullable<ReturnType<typeof findAgentIdentityMarker>>;

const ATTACHMENT_BLOCK_TYPES: readonly string[] = ['attachment', 'document', 'image'];

/** Hook rows are system rows carrying hook output, or rows with a hook_result block. */
const isHookRow = (record: JsonObject, hookBlock: boolean): boolean =>
  record.type === 'system'
  && (record.subtype === 'hook_response' || 'hookSpecificOutput' in record || hookBlock);

const hasAttachmentBlock = (blockTypes: ReadonlySet<string | undefined>): boolean =>
  [...blockTypes].some((type) => type !== undefined && ATTACHMENT_BLOCK_TYPES.includes(type));

/** Structured content wins over the declared role; anything else falls back to it. */
const blockRole = (blockTypes: ReadonlySet<string | undefined>): TranscriptRole | undefined => {
  if (blockTypes.has('tool_use')) return 'tool_call';
  if (blockTypes.has('tool_result')) return 'tool_result';
  return hasAttachmentBlock(blockTypes) ? 'attachment' : undefined;
};

function claudeRole(
  record: JsonObject,
  declared: unknown,
  blockTypes: ReadonlySet<string | undefined>,
  hookBlock: boolean,
): TranscriptRole {
  if (isHookRow(record, hookBlock)) return 'hook';
  return blockRole(blockTypes) ?? declaredRole(declared) ?? 'system';
}

/** Roles whose text is the serialized structure rather than prose. */
const structuredRole = (role: TranscriptRole): boolean =>
  role === 'tool_call'
  || role === 'tool_result'
  || role === 'attachment'
  || role === 'hook';

/** Structured roles keep their JSON; prose roles keep their text; user text is display-cleaned. */
const lineText = (role: TranscriptRole, content: unknown): string => {
  const normalized = structuredRole(role) ? jsonText(content) : contentText(content) ?? '';
  return role === 'user' ? displayUserText(normalized) : normalized;
};

const contentBlocks = (message: JsonObject): readonly JsonObject[] =>
  Array.isArray(message.content) ? message.content.filter(isObject) : [];

/** The identity marker line: internal, resumable, and correlated to its turn. */
function hookLine(record: JsonObject, agentIdentity: AgentIdentity): NormalizedProviderLine {
  const turnId = textValue(record.uuid);
  return {
    role: 'hook',
    text: JSON.stringify(agentIdentity),
    audience: 'internal',
    agentIdentity,
    ...present('resumeId', textValue(record.sessionId)),
    ...present('providerLineId', turnId),
    ...present('turnId', turnId),
    ...present('providerOccurredAt', textValue(record.timestamp)),
  };
}

/** One Claude message row in the provider-neutral vocabulary. */
function messageLine(record: JsonObject, message: JsonObject): NormalizedProviderLine {
  const blocks = contentBlocks(message);
  const blockTypes = new Set(blocks.map((block) => textValue(block.type)));
  const role = claudeRole(
    record,
    message.role,
    blockTypes,
    blocks.some((block) => block.type === 'hook_result'),
  );
  const text = lineText(role, message.content);
  const turnId = textValue(record.uuid);
  const audience: NormalizedProviderLine['audience'] = conversational(role, text)
    ? 'conversation'
    : 'internal';
  return {
    role,
    text,
    audience,
    ...present('providerLineId', turnId),
    ...present('resumeId', textValue(record.sessionId)),
    ...present('turnId', turnId),
    ...present('parentTurnId', textValue(record.parentUuid)),
    ...present('tokenUsage', numericUsage(message.usage)),
    ...present('providerOccurredAt', textValue(record.timestamp)),
    ...present('correlationHint', userCorrelation(role, audience, text)),
    ...present('toolCall', role === 'tool_call' ? blocks[0] : undefined),
  };
}

/** Claude JSONL to the provider-neutral TranscriptLine vocabulary. */
export const claudeNormalizer: ProviderNormalizer = {
  provider: 'claude',
  normalize(extent) {
    const record = parseExtent(extent);
    if (record === null) return noise();
    const agentIdentity = findAgentIdentityMarker(record);
    if (agentIdentity !== undefined) return hookLine(record, agentIdentity);
    if (!isObject(record.message)) return noise(textValue(record.sessionId));
    return messageLine(record, record.message);
  },
};

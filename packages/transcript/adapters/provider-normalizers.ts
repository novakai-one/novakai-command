import {
  SessionRef,
  type ProviderName,
  type TranscriptDiagnostic,
  type TranscriptRelationState,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import { normalizeKimi } from './kimi-normalizer.js';
import {
  contentText,
  diagnostic,
  isRecord,
  nonMessage,
  numericUsage,
  serializedText,
  stringValue,
  unsupported,
  type ProviderAgentResolver,
  type ProviderSessionResolver,
} from './provider-normalizer-support.js';

export type {
  ProviderAgentResolver,
  ProviderSessionResolver,
} from './provider-normalizer-support.js';

function normalizeClaude(
  row: unknown,
  content: string,
  offset: number,
  nextOffset: number,
  turnIndex: number,
  resolver?: ProviderSessionResolver,
): TranscriptSourceItem {
  if (
    isRecord(row)
    && row.type === 'system'
    && !isRecord(row.message)
  ) {
    return nonMessage(offset, nextOffset, 'claude');
  }
  if (
    isRecord(row)
    && stringValue(row.type)
    && !isRecord(row.message)
    && !['user', 'assistant', 'system'].includes(String(row.type))
  ) {
    return nonMessage(offset, nextOffset, 'claude');
  }
  if (
    !isRecord(row)
    || !stringValue(row.type)
    || !stringValue(row.uuid)
    || !isRecord(row.message)
  ) {
    return unsupported(offset, nextOffset, 'claude');
  }
  const message = row.message;
  const roleValue = stringValue(message.role);
  if (
    roleValue !== 'user'
    && roleValue !== 'assistant'
    && roleValue !== 'system'
    && roleValue !== 'tool'
  ) {
    return unsupported(offset, nextOffset, 'claude');
  }
  const blocks = Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : [];
  if (
    blocks.length > 0
    && blocks.every(
      (block) =>
        stringValue(block.type) === 'thinking'
        || stringValue(block.type) === 'fallback',
    )
  ) {
    return nonMessage(offset, nextOffset, 'claude');
  }
  const blockTypes = new Set(blocks.map((block) => stringValue(block.type)));
  const role = blockTypes.has('tool_use')
    ? 'tool_call'
    : blockTypes.has('tool_result')
      ? 'tool_result'
      : [...blockTypes].some(
          (type) =>
            type === 'attachment'
            || type === 'document'
            || type === 'image',
        )
        ? 'attachment'
        : roleValue;
  const text = (
    role === 'tool_call'
    || role === 'tool_result'
    || role === 'attachment'
  )
    ? serializedText(message.content)
    : contentText(message.content);
  if (text === undefined) {
    return unsupported(offset, nextOffset, 'claude');
  }
  const nativeSessionId = stringValue(row.sessionId);
  const resolvedSession = nativeSessionId && resolver
    ? SessionRef.safeParse(resolver('claude', nativeSessionId))
    : undefined;
  const diagnostics: TranscriptDiagnostic[] = [];
  if (nativeSessionId && (!resolvedSession || !resolvedSession.success)) {
    diagnostics.push(diagnostic(
      'session_ref_unresolved',
      'provider-native session has no verified providerSession resolver',
    ));
  }
  if (row.isSidechain === true) {
    diagnostics.push(diagnostic(
      'agent_attribution_unavailable',
      'provider sidechain identity is not a verified durable agent id',
    ));
  }
  const uuid = stringValue(row.uuid)!;
  const usage = numericUsage(message.usage);
  return {
    kind: 'candidate',
    offset,
    nextOffset,
    content,
    line: {
      nativeId: uuid,
      turnId: uuid,
      turnIndex,
      role,
      text,
      ...(usage ? { tokenUsage: usage } : {}),
      ...(row.isSidechain === true && stringValue(row.parentUuid)
        ? { parentTurnId: stringValue(row.parentUuid) }
        : {}),
      ...(resolvedSession?.success
        ? { sessionRef: resolvedSession.data }
        : {}),
    },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function normalizeCodex(
  row: unknown,
  content: string,
  offset: number,
  nextOffset: number,
  turnIndex: number,
  sourceId?: string,
): TranscriptSourceItem {
  if (isRecord(row) && !stringValue(row.type)) {
    return nonMessage(offset, nextOffset, 'codex');
  }
  if (
    isRecord(row)
    && stringValue(row.type)
    && row.type !== 'response_item'
    && row.type !== 'event_msg'
  ) {
    return nonMessage(offset, nextOffset, 'codex');
  }
  if (
    !isRecord(row)
    || (row.type !== 'response_item' && row.type !== 'event_msg')
    || !isRecord(row.payload)
  ) {
    return unsupported(offset, nextOffset, 'codex');
  }
  const payload = row.payload;
  const responseRole = stringValue(payload.role);
  const eventType = stringValue(payload.type);
  if (
    eventType === 'token_count'
    || eventType === 'reasoning'
    || eventType === 'agent_reasoning'
  ) {
    return nonMessage(offset, nextOffset, 'codex');
  }
  const contentParts = Array.isArray(payload.content)
    ? payload.content.filter(isRecord)
    : [];
  const contentTypes = new Set(
    contentParts.map((part) => stringValue(part.type)),
  );
  const role = row.type === 'response_item'
    ? eventType === 'function_call'
      || eventType === 'custom_tool_call'
      || eventType === 'web_search_call'
      ? 'tool_call'
      : eventType === 'function_call_output'
        || eventType === 'custom_tool_call_output'
        ? 'tool_result'
        : [...contentTypes].some(
            (type) =>
              type === 'input_image'
              || type === 'input_file'
              || type === 'attachment',
          )
          ? 'attachment'
          : responseRole === 'developer'
            ? 'system'
            : responseRole
    : eventType === 'user_message'
      ? 'user'
      : eventType === 'agent_message'
        ? 'assistant'
        : undefined;
  if (
    role !== 'user'
    && role !== 'assistant'
    && role !== 'system'
    && role !== 'tool'
    && role !== 'tool_call'
    && role !== 'tool_result'
    && role !== 'attachment'
  ) {
    return nonMessage(offset, nextOffset, 'codex');
  }
  const text = (
    role === 'tool_call'
      ? serializedText({
          type: eventType,
          name: payload.name,
          arguments: payload.arguments,
        })
      : role === 'tool_result'
        ? serializedText({
            type: eventType,
            output: payload.output,
          })
      : role === 'attachment'
        ? serializedText(payload.content)
        : contentText(payload.content) ?? stringValue(payload.message)
  );
  if (text === undefined) {
    return unsupported(offset, nextOffset, 'codex');
  }
  const metadata = isRecord(
    payload.internal_chat_message_metadata_passthrough,
  )
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  const providerTurnId = (
    stringValue(payload.turn_id)
    ?? stringValue(metadata?.turn_id)
    ?? stringValue(payload.id)
  );
  const turnId = providerTurnId ?? (
    sourceId ? `${sourceId}:${turnIndex}` : undefined
  );
  if (!turnId) return unsupported(offset, nextOffset, 'codex');
  const nativeId = stringValue(payload.id);
  const source = isRecord(payload.source) ? payload.source : undefined;
  const diagnostics: TranscriptDiagnostic[] = [];
  if (source?.subagent !== undefined) {
    diagnostics.push(diagnostic(
      'agent_attribution_unavailable',
      'provider subagent metadata is not a verified durable agent id',
    ));
  }
  const usage = numericUsage(payload.usage);
  return {
    kind: 'candidate',
    offset,
    nextOffset,
    content,
    line: {
      ...(nativeId ? { nativeId } : {}),
      turnId,
      turnIndex,
      role,
      text,
      ...(usage ? { tokenUsage: usage } : {}),
    },
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

export function normalizeProviderLine(
  provider: ProviderName,
  content: string,
  offset: number,
  nextOffset: number,
  resolver?: ProviderSessionResolver,
  relationState?: TranscriptRelationState,
  agentResolver?: ProviderAgentResolver,
  turnIndex = 0,
  sourceId?: string,
): TranscriptSourceItem {
  let row: unknown;
  try {
    row = JSON.parse(content);
  } catch {
    return {
      kind: 'skip',
      offset,
      nextOffset,
      reason: {
        code: 'malformed_json',
        message: 'provider row is not valid JSON',
      },
    };
  }
  if (provider === 'kimi') {
    return normalizeKimi(
      row,
      content,
      offset,
      nextOffset,
      resolver,
      relationState,
      agentResolver,
      turnIndex,
    );
  }
  if (provider === 'claude') {
    return normalizeClaude(
      row,
      content,
      offset,
      nextOffset,
      turnIndex,
      resolver,
    );
  }
  return normalizeCodex(
    row,
    content,
    offset,
    nextOffset,
    turnIndex,
    sourceId,
  );
}

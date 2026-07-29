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
  numericUsage,
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
  resolver?: ProviderSessionResolver,
): TranscriptSourceItem {
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
  const text = contentText(message.content);
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
      turnIndex: offset,
      role: roleValue,
      text,
      ...(usage ? { tokenUsage: usage } : {}),
      ...(stringValue(row.parentUuid)
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
): TranscriptSourceItem {
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
  const role = row.type === 'response_item'
    ? responseRole
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
  ) {
    return unsupported(offset, nextOffset, 'codex');
  }
  const text = (
    contentText(payload.content)
    ?? stringValue(payload.message)
  );
  if (text === undefined) {
    return unsupported(offset, nextOffset, 'codex');
  }
  const metadata = isRecord(
    payload.internal_chat_message_metadata_passthrough,
  )
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  const turnId = (
    stringValue(payload.turn_id)
    ?? stringValue(metadata?.turn_id)
    ?? stringValue(payload.id)
  );
  if (!turnId) return unsupported(offset, nextOffset, 'codex');
  const nativeId = stringValue(payload.id) ?? turnId;
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
      nativeId,
      turnId,
      turnIndex: offset,
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
    );
  }
  if (provider === 'claude') {
    return normalizeClaude(row, content, offset, nextOffset, resolver);
  }
  return normalizeCodex(row, content, offset, nextOffset);
}

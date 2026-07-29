import { createHash } from 'node:crypto';
import {
  SessionRef,
  type NormalizedTranscriptLine,
  type ProviderName,
  type SessionRef as SessionRefT,
  type TranscriptDiagnostic,
  type TranscriptRelationState,
  type TranscriptSourceItem,
} from '../contract/schemas.js';

export type ProviderSessionResolver = (
  provider: ProviderName,
  nativeSessionId: string,
) => SessionRefT | undefined;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

function identityValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? String(value)
    : undefined;
}

function relationKey(kind: string, nativeId: string): string {
  const digest = createHash('sha256')
    .update(`kimi:${kind}:${nativeId}`)
    .digest('hex');
  return `relation_${digest}`;
}

function emptyRelationState(): TranscriptRelationState {
  return { parents: {}, children: {} };
}

function numericUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && Number(entry[1]) >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.content === 'string') return value.content;
  return undefined;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (isRecord(part) && typeof part.text === 'string') {
      return [part.text];
    }
    return [];
  });
  return text.length > 0 ? text.join('\n') : undefined;
}

function diagnostic(
  code: TranscriptDiagnostic['code'],
  message: string,
): TranscriptDiagnostic {
  return { code, message };
}

function unsupported(
  offset: number,
  nextOffset: number,
  provider: ProviderName,
): TranscriptSourceItem {
  return {
    kind: 'skip',
    offset,
    nextOffset,
    reason: {
      code: 'unsupported_shape',
      message: `${provider} row does not expose a supported transcript message shape`,
    },
  };
}

function normalizeKimi(
  row: unknown,
  content: string,
  offset: number,
  nextOffset: number,
  resolver?: ProviderSessionResolver,
  relationState?: TranscriptRelationState,
): TranscriptSourceItem {
  if (!isRecord(row) || row.kind !== 'event' || !isRecord(row.envelope)) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const envelope = row.envelope;
  if (
    !Number.isInteger(envelope.seq)
    || Number(envelope.seq) < 0
    || !isRecord(envelope.payload)
  ) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const payload = envelope.payload;
  const eventType = (
    stringValue(envelope.type)
    ?? stringValue(payload.type)
  );
  const currentRelations = relationState ?? emptyRelationState();
  if (eventType === 'tool.call.started') {
    const toolCallId = stringValue(payload.toolCallId);
    const turnId = identityValue(payload.turnId);
    if (!toolCallId || !turnId) {
      return unsupported(offset, nextOffset, 'kimi');
    }
    const parentKey = relationKey('tool', toolCallId);
    return {
      kind: 'context',
      offset,
      nextOffset,
      relationState: {
        parents: {
          ...currentRelations.parents,
          [parentKey]: { nativeParentTurnId: turnId },
        },
        children: currentRelations.children,
      },
    };
  }
  if (eventType === 'subagent.spawned') {
    const subagentId = stringValue(payload.subagentId);
    const parentToolCallId = stringValue(payload.parentToolCallId);
    if (!subagentId || !parentToolCallId) {
      return unsupported(offset, nextOffset, 'kimi');
    }
    const childKey = relationKey('agent', subagentId);
    return {
      kind: 'context',
      offset,
      nextOffset,
      relationState: {
        parents: currentRelations.parents,
        children: {
          ...currentRelations.children,
          [childKey]: {
            parentKey: relationKey('tool', parentToolCallId),
          },
        },
      },
    };
  }
  const text = (
    stringValue(payload.output)
    ?? stringValue(payload.prompt)
    ?? messageText(payload.message)
  );
  if (text === undefined) {
    return unsupported(offset, nextOffset, 'kimi');
  }
  const message = isRecord(payload.message) ? payload.message : undefined;
  const explicitRole = stringValue(message?.role);
  const role = eventType === 'tool.result'
    ? 'tool'
    : explicitRole === 'user'
    || explicitRole === 'assistant'
    || explicitRole === 'system'
    || explicitRole === 'tool'
    ? explicitRole
    : payload.prompt !== undefined
      ? 'user'
      : 'assistant';
  const nativeSessionId = (
    stringValue(payload.sessionId)
    ?? stringValue(envelope.session_id)
  );
  const resolvedSession = nativeSessionId && resolver
    ? SessionRef.safeParse(resolver('kimi', nativeSessionId))
    : undefined;
  const diagnostics: TranscriptDiagnostic[] = [];
  if (nativeSessionId && (!resolvedSession || !resolvedSession.success)) {
    diagnostics.push(diagnostic(
      'session_ref_unresolved',
      'provider-native session has no verified providerSession resolver',
    ));
  }
  const agentId = stringValue(payload.agentId);
  if (!agentId && stringValue(payload.subagentId)) {
    diagnostics.push(diagnostic(
      'agent_attribution_unavailable',
      'provider subagent identity is not a verified durable agent id',
    ));
  }
  const turnId = identityValue(payload.turnId);
  const nativeAgentId = stringValue(payload.agentId);
  const childRelation = nativeAgentId
    ? currentRelations.children[relationKey('agent', nativeAgentId)]
    : undefined;
  const parentRelation = childRelation
    ? currentRelations.parents[childRelation.parentKey]
    : undefined;
  const usage = numericUsage(payload.usage);
  const line: NormalizedTranscriptLine = {
    ...(turnId ? { nativeId: turnId, turnId } : {}),
    turnIndex: Number(envelope.seq),
    role,
    text,
    ...(usage ? { tokenUsage: usage } : {}),
    ...(agentId ? { agentId } : {}),
    ...(stringValue(payload.parentAgentId)
      ? { parentAgentId: stringValue(payload.parentAgentId) }
      : {}),
    ...(parentRelation
      ? { parentTurnId: parentRelation.nativeParentTurnId }
      : stringValue(payload.parentToolCallId)
        ? { parentTurnId: stringValue(payload.parentToolCallId) }
        : {}),
    ...(resolvedSession?.success
      ? { sessionRef: resolvedSession.data }
      : {}),
  };
  return {
    kind: 'candidate',
    offset,
    nextOffset,
    content,
    line,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

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
    );
  }
  if (provider === 'claude') {
    return normalizeClaude(row, content, offset, nextOffset, resolver);
  }
  return normalizeCodex(row, content, offset, nextOffset);
}

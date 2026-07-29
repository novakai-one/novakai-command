import { createHash } from 'node:crypto';
import {
  SessionRef,
  type NormalizedTranscriptLine,
  type TranscriptDiagnostic,
  type TranscriptRelationDelta,
  type TranscriptRelationState,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import {
  diagnostic,
  identityValue,
  isRecord,
  messageText,
  nonMessage,
  numericUsage,
  serializedText,
  stringValue,
  unsupported,
  type ProviderAgentResolver,
  type ProviderSessionResolver,
} from './provider-normalizer-support.js';

function relationKey(kind: string, nativeId: string): string {
  const digest = createHash('sha256')
    .update(`kimi:${kind}:${nativeId}`)
    .digest('hex');
  return `relation_${digest}`;
}

function lineIdentity(
  nativeSessionId: string,
  sequence: number,
  nativeToolCallId: string | undefined,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'kimi',
      'event',
      nativeSessionId,
      sequence,
      nativeToolCallId ?? null,
    ]))
    .digest('hex');
  return `event_${digest}`;
}

function turnIdentity(
  nativeSessionId: string,
  nativeTurnId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'kimi',
      'turn',
      nativeSessionId,
      nativeTurnId,
    ]))
    .digest('hex');
  return `turn_${digest}`;
}

function expectedSpawnCount(payload: Record<string, unknown>): number | undefined {
  const toolName = stringValue(payload.name);
  if (toolName === 'Agent') return 1;
  if (toolName !== 'AgentSwarm' || !isRecord(payload.args)) {
    return undefined;
  }
  const items = payload.args.items;
  return Array.isArray(items) && items.length > 0
    ? items.length
    : undefined;
}

export function normalizeKimi(
  row: unknown,
  content: string,
  offset: number,
  nextOffset: number,
  resolver?: ProviderSessionResolver,
  relationState?: TranscriptRelationState,
  agentResolver?: ProviderAgentResolver,
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
  const nativeSessionId = (
    stringValue(payload.sessionId)
    ?? stringValue(envelope.session_id)
  );
  const currentRelations = relationState ?? { parents: {}, children: {} };
  let relation: TranscriptRelationDelta | undefined;
  if (eventType === 'tool.call.started') {
    const toolName = stringValue(payload.name);
    const remainingChildren = expectedSpawnCount(payload);
    if (toolName === 'Agent' || toolName === 'AgentSwarm') {
      const toolCallId = stringValue(payload.toolCallId);
      const nativeTurnId = identityValue(payload.turnId);
      const turnId = nativeSessionId && nativeTurnId
        ? turnIdentity(nativeSessionId, nativeTurnId)
        : undefined;
      if (!remainingChildren || !toolCallId || !turnId) {
        return unsupported(offset, nextOffset, 'kimi');
      }
      const nativeParentAgentId = stringValue(payload.agentId);
      const parentAgentId = nativeParentAgentId
        ? agentResolver?.('kimi', nativeParentAgentId)
        : undefined;
      relation = {
        type: 'parent',
        parentKey: relationKey('tool', toolCallId),
        parentTurnId: turnId,
        remainingChildren,
        ...(parentAgentId ? { parentAgentId } : {}),
      };
    }
  }
  if (eventType === 'subagent.spawned') {
    const subagentId = stringValue(payload.subagentId);
    const parentToolCallId = stringValue(payload.parentToolCallId);
    if (!subagentId || !parentToolCallId) {
      return unsupported(offset, nextOffset, 'kimi');
    }
    const childKey = relationKey('agent', subagentId);
    const parentKey = relationKey('tool', parentToolCallId);
    if (!currentRelations.parents[parentKey]) {
      return { kind: 'context', offset, nextOffset };
    }
    const agentId = agentResolver?.('kimi', subagentId);
    return {
      kind: 'context',
      offset,
      nextOffset,
      relation: {
        type: 'child',
        childKey,
        parentKey,
        ...(agentId ? { agentId } : {}),
      },
    };
  }
  const message = isRecord(payload.message) ? payload.message : undefined;
  const explicitRole = stringValue(message?.role);
  const messageParts = Array.isArray(message?.content)
    ? message.content.filter(isRecord)
    : [];
  const messagePartTypes = new Set(
    messageParts.map((part) => stringValue(part.type)),
  );
  const isAttachment = (
    eventType === 'attachment'
    || [...messagePartTypes].some(
      (type) =>
        type === 'attachment'
        || type === 'document'
        || type === 'image',
    )
  );
  const role = eventType === 'tool.call.started'
    ? 'tool_call'
    : eventType === 'tool.result'
      ? 'tool_result'
      : isAttachment
        ? 'attachment'
    : explicitRole === 'user'
    || explicitRole === 'assistant'
    || explicitRole === 'system'
    || explicitRole === 'tool'
    ? explicitRole
    : payload.prompt !== undefined
      ? 'user'
      : 'assistant';
  const text = role === 'tool_call'
    ? serializedText({
        name: payload.name,
        args: payload.args,
      })
    : role === 'tool_result'
      ? stringValue(payload.output) ?? serializedText(payload.message)
    : role === 'attachment'
      ? serializedText(message?.content ?? payload)
      : (
          stringValue(payload.output)
          ?? stringValue(payload.prompt)
          ?? messageText(payload.message)
        );
  if (text === undefined) {
    return nonMessage(offset, nextOffset, 'kimi');
  }
  const resolvedSession = nativeSessionId && resolver
    ? SessionRef.safeParse(resolver('kimi', nativeSessionId))
    : undefined;
  const nativeAgentId = stringValue(payload.agentId);
  const nativeParentAgentId = stringValue(payload.parentAgentId);
  const childRelation = nativeAgentId
    ? currentRelations.children[relationKey('agent', nativeAgentId)]
    : undefined;
  const resolvedAgentId = (
    childRelation?.agentId
    ?? (nativeAgentId
      ? agentResolver?.('kimi', nativeAgentId)
      : undefined)
  );
  const resolvedParentAgentId = (
    childRelation?.parentAgentId
    ?? (nativeParentAgentId
      ? agentResolver?.('kimi', nativeParentAgentId)
      : undefined)
  );
  const diagnostics: TranscriptDiagnostic[] = [];
  if (nativeSessionId && (!resolvedSession || !resolvedSession.success)) {
    diagnostics.push(diagnostic(
      'session_ref_unresolved',
      'provider-native session has no verified providerSession resolver',
    ));
  }
  if (
    (nativeAgentId && !resolvedAgentId)
    || (nativeParentAgentId && !resolvedParentAgentId)
    || stringValue(payload.subagentId)
  ) {
    diagnostics.push(diagnostic(
      'agent_attribution_unavailable',
      'provider agent identity has no verified durable agent resolver',
    ));
  }
  const nativeTurnId = identityValue(payload.turnId);
  const turnId = nativeSessionId && nativeTurnId
    ? turnIdentity(nativeSessionId, nativeTurnId)
    : undefined;
  const nativeId = nativeSessionId
    ? lineIdentity(
        nativeSessionId,
        Number(envelope.seq),
        stringValue(payload.toolCallId),
      )
    : undefined;
  const usage = numericUsage(payload.usage);
  const line: NormalizedTranscriptLine = {
    ...(nativeId ? { nativeId } : {}),
    ...(turnId ? { turnId } : {}),
    turnIndex: Number(envelope.seq),
    role,
    text,
    ...(usage ? { tokenUsage: usage } : {}),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    ...(resolvedParentAgentId
      ? { parentAgentId: resolvedParentAgentId }
      : {}),
    ...(childRelation
      ? { parentTurnId: childRelation.parentTurnId }
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
    ...(relation ? { relation } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

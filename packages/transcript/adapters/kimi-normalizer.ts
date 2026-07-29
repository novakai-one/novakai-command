import { createHash } from 'node:crypto';
import {
  SessionRef,
  type NormalizedTranscriptLine,
  type TranscriptDiagnostic,
  type TranscriptRelationState,
  type TranscriptSourceItem,
} from '../contract/schemas.js';
import {
  diagnostic,
  identityValue,
  isRecord,
  messageText,
  numericUsage,
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

function emptyRelationState(): TranscriptRelationState {
  return { parents: {}, children: {} };
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
  const currentRelations = relationState ?? emptyRelationState();
  if (eventType === 'tool.call.started') {
    const toolCallId = stringValue(payload.toolCallId);
    const nativeTurnId = identityValue(payload.turnId);
    const turnId = nativeSessionId && nativeTurnId
      ? turnIdentity(nativeSessionId, nativeTurnId)
      : undefined;
    if (!toolCallId || !turnId) {
      return unsupported(offset, nextOffset, 'kimi');
    }
    const parentKey = relationKey('tool', toolCallId);
    const nativeParentAgentId = stringValue(payload.agentId);
    const parentAgentId = nativeParentAgentId
      ? agentResolver?.('kimi', nativeParentAgentId)
      : undefined;
    return {
      kind: 'context',
      offset,
      nextOffset,
      relationState: {
        parents: {
          ...currentRelations.parents,
          [parentKey]: {
            nativeParentTurnId: turnId,
            ...(parentAgentId ? { parentAgentId } : {}),
          },
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
    const agentId = agentResolver?.('kimi', subagentId);
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
            ...(agentId ? { agentId } : {}),
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
  const resolvedSession = nativeSessionId && resolver
    ? SessionRef.safeParse(resolver('kimi', nativeSessionId))
    : undefined;
  const nativeAgentId = stringValue(payload.agentId);
  const nativeParentAgentId = stringValue(payload.parentAgentId);
  const childRelation = nativeAgentId
    ? currentRelations.children[relationKey('agent', nativeAgentId)]
    : undefined;
  const parentRelation = childRelation
    ? currentRelations.parents[childRelation.parentKey]
    : undefined;
  const resolvedAgentId = (
    childRelation?.agentId
    ?? (nativeAgentId
      ? agentResolver?.('kimi', nativeAgentId)
      : undefined)
  );
  const resolvedParentAgentId = (
    parentRelation?.parentAgentId
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
    ...(parentRelation
      ? { parentTurnId: parentRelation.nativeParentTurnId }
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

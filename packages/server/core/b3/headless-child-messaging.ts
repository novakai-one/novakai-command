import { createHash } from 'node:crypto';
import { b3err, b3fail, b3ok, mintClientOpId } from '@novakai/foundation/contract';
import type { HeadlessChildMessagingPort } from '../../../agent-runtime/contract/index.js';
import type { AgentsContract } from '../../../agents/contract/index.js';
import type { MessagingRuntimeApi } from '../../../messaging/contract/index.js';

interface HeadlessChildOptions {
  readonly messaging: Pick<
    MessagingRuntimeApi,
    'ensureConversationView' | 'sendConversationMessage' | 'ingestNow' | 'listSendJournals'
    | 'listProviderSessions'
  >;
  readonly agents: Pick<AgentsContract, 'spawnAgent'>;
  readonly emit?: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
}

type PrepareInput = Parameters<HeadlessChildMessagingPort['prepare']>[0];
type DispatchInput = Parameters<HeadlessChildMessagingPort['dispatchBrief']>[0];

const conversationIdFor = (agentId: string): string =>
  `conv_child_${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`;

/** Bind governed child creation to target Conversation View and SendJournal paths. */
export function createHeadlessChildMessagingPort(
  options: HeadlessChildOptions,
): HeadlessChildMessagingPort {
  return {
    prepare: (input) => prepareChild(options, input),
    dispatchBrief: (input) => dispatchBrief(options, input),
  };
}

async function prepareChild(
  options: HeadlessChildOptions,
  input: PrepareInput,
) {
  const conversationId = conversationIdFor(input.agentId);
  const lastActivityAt = new Date().toISOString();
  const view = await options.messaging.ensureConversationView({
    conversationId,
    participantIds: [input.rootHumanPrincipalId, input.agentId],
    clientOpId: String(input.clientOpId),
    titleOverride: input.displayName,
    address: `agent:${input.agentId}`,
    agentId: input.agentId,
    provider: input.provider,
    lastActivityAt,
  });
  if (view.kind === 'error') {
    return b3fail(b3err('StoreUnavailable', view.error.message, {
      owner: 'messaging', cause: view.error.name,
    }, view.error.retryable));
  }

  // Runtime creation is in-memory preparation only. Provider execution starts
  // after Agent Runtime has issued the child's delegation grants.
  const prepared = await options.agents.spawnAgent(input.agentId as never, {
    env: { ...input.environment },
  }, mintClientOpId());
  if (!prepared.ok) {
    return b3fail(b3err('RuntimeUnavailable', prepared.error.message, {
      agentId: input.agentId,
      reason: prepared.error.code,
    }, prepared.error.retryable));
  }
  emitConversation(options, input, conversationId, lastActivityAt);
  return b3ok({ conversationId });
}

function emitConversation(
  options: HeadlessChildOptions,
  input: PrepareInput,
  conversationId: string,
  lastActivityAt: string,
): void {
  options.emit?.('conversation.created', {
    id: conversationId,
    threadId: `agent:${input.agentId}`,
    title: input.displayName,
    kind: 'agent',
    pinned: false,
    archived: false,
    lastActivityAt,
    agentId: input.agentId,
  });
}

async function dispatchBrief(options: HeadlessChildOptions, input: DispatchInput) {
  const accepted = await options.messaging.sendConversationMessage({
    conversationId: input.conversationId,
    issuedBy: input.parentAgentId,
    targetAgentId: input.agentId,
    text: input.brief,
    clientOpId: `${String(input.clientOpId)}:child-brief`,
  });
  if (accepted.kind === 'error') {
    return b3fail(b3err('RuntimeUnavailable', accepted.error.message, {
        agentId: input.agentId, dependency: 'messaging',
      }, accepted.error.retryable));
  }
  let providerSessionId = accepted.value.targetSessionId;
  if (providerSessionId === undefined) {
    const ingested = await options.messaging.ingestNow();
    if (ingested.kind === 'error') {
      return b3fail(b3err('RuntimeUnavailable', ingested.error.message, {
        agentId: input.agentId, dependency: 'messaging-ingestion',
      }, ingested.error.retryable));
    }
    const journals = await options.messaging.listSendJournals();
    if (journals.kind === 'error') {
      return b3fail(b3err('RuntimeUnavailable', journals.error.message, {
        agentId: input.agentId, dependency: 'messaging-journal',
      }, journals.error.retryable));
    }
    providerSessionId = journals.value.find((journal) =>
      journal.id === accepted.value.sendId)?.targetSessionId;
  }
  if (providerSessionId === undefined) {
    return b3fail(b3err('RuntimeUnavailable',
      'provider reply completed before Messaging assigned its ProviderSession', {
        agentId: input.agentId,
        sendId: accepted.value.sendId,
        dependency: 'messaging-ingestion',
      }, true));
  }
  const sessions = await options.messaging.listProviderSessions();
  if (sessions.kind === 'error') {
    return b3fail(b3err('RuntimeUnavailable', sessions.error.message, {
      agentId: input.agentId, dependency: 'messaging-provider-session',
    }, sessions.error.retryable));
  }
  const providerSession = sessions.value.find((session) => session.id === providerSessionId);
  if (providerSession === undefined) {
    return b3fail(b3err('RuntimeUnavailable',
      `Messaging assigned unknown ProviderSession ${providerSessionId}`, {
        agentId: input.agentId,
        sendId: accepted.value.sendId,
        providerSessionId,
      }, true));
  }
  return b3ok({
    sendId: accepted.value.sendId,
    providerSessionId: providerSessionId as never,
    providerResumeId: providerSession.resumeId ?? null,
    response: accepted.value.response ?? '',
  });
}

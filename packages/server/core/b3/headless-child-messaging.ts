import { createHash } from 'node:crypto';
import { b3err, b3fail, b3ok, mintClientOpId } from '@novakai/foundation/contract';
import type { HeadlessChildMessagingPort } from '../../../agent-runtime/contract/index.js';
import type { AgentsContract } from '../../../agents/contract/index.js';
import type { MessagingRuntimeApi } from '../../../messaging/contract/index.js';
import { setConversationView } from '../../../shell/contract/conversationView.js';
import { composeShellPersistence } from '../../../shell/contract/persistence.node.js';

interface HeadlessChildOptions {
  readonly root: string;
  readonly dataRoot: string;
  readonly messaging: Pick<MessagingRuntimeApi, 'sendConversationMessage'>;
  readonly agents: Pick<AgentsContract, 'spawnAgent'>;
  readonly emit?: (kind: string, payload: Readonly<Record<string, unknown>>) => void;
}

type PrepareInput = Parameters<HeadlessChildMessagingPort['prepare']>[0];
type DispatchInput = Parameters<HeadlessChildMessagingPort['dispatchBrief']>[0];
type ConversationViewDriver = ReturnType<
  typeof composeShellPersistence
>['conversationViewDriver'];

const conversationIdFor = (agentId: string): string =>
  `conv_child_${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`;

/** Bind governed child creation to target Conversation View and SendJournal paths. */
export function createHeadlessChildMessagingPort(
  options: HeadlessChildOptions,
): HeadlessChildMessagingPort {
  const { conversationViewDriver } = composeShellPersistence({
    root: options.root,
    dataRoot: options.dataRoot,
    principal: 'sys_shell',
  });
  return {
    prepare: (input) => prepareChild(options, conversationViewDriver, input),
    dispatchBrief: (input) => dispatchBrief(options, input),
  };
}

async function prepareChild(
  options: HeadlessChildOptions,
  conversationViewDriver: ConversationViewDriver,
  input: PrepareInput,
) {
  const conversationId = conversationIdFor(input.agentId);
  const lastActivityAt = new Date().toISOString();
  const view = await persistConversationView(
    conversationViewDriver, input, conversationId, lastActivityAt,
  );
  if (!view.ok) return view;

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

async function persistConversationView(
  driver: ConversationViewDriver,
  input: PrepareInput,
  conversationId: string,
  lastActivityAt: string,
) {
  const view = await setConversationView(driver, conversationId, {
    threadRef: null,
    address: `agent:${input.agentId}`,
    pinned: false,
    archived: false,
    titleOverride: input.displayName,
    lastActivityAt,
    openedForPrincipalId: input.rootHumanPrincipalId,
    membershipKind: 'direct',
    agentId: input.agentId,
    provider: input.provider,
  }, String(input.clientOpId));
  return view.ok
    ? b3ok(null)
    : b3fail(b3err('StoreUnavailable', view.error.message, {
        owner: 'shell', cause: view.error.code,
      }, view.error.retryable));
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
  return accepted.kind === 'error'
    ? b3fail(b3err('RuntimeUnavailable', accepted.error.message, {
        agentId: input.agentId, dependency: 'messaging',
      }, accepted.error.retryable))
    : b3ok({ sendId: accepted.value.sendId });
}

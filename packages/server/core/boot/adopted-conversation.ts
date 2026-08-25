import { createHash } from 'node:crypto';
import type { ConversationDirectory } from '../../../messaging/contract/index.js';
import { setConversationView } from '../../../shell/contract/conversationView.js';
import { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import type { Conversation } from '../methods/runtime.js';

type Listener = (conversation: Conversation) => void;

interface AdoptedConversationDirectory {
  readonly port: ConversationDirectory;
  subscribe(listener: Listener): { close(): void };
}

const conversationIdFor = (agentId: string): string =>
  `conv_external_${createHash('sha256').update(agentId).digest('hex').slice(0, 32)}`;

const pairConversationId = (participants: readonly string[]): string =>
  `conv_agents_${createHash('sha256').update([...participants].sort().join(':')).digest('hex').slice(0, 32)}`;

const titleFor = (provider: string, resumeId: string | undefined): string => {
  const providerName = `${provider[0]?.toUpperCase() ?? ''}${provider.slice(1)}`;
  return `External ${providerName} ${resumeId?.slice(-8) ?? 'session'}`;
};

/** Persists and announces the Shell view required for an adopted Agent. */
export function createAdoptedConversationDirectory(options: {
  readonly root: string;
  readonly dataRoot: string;
  readonly humanPrincipalId: string;
}): AdoptedConversationDirectory {
  const { conversationViewDriver } = composeShellPersistence({
    root: options.root,
    dataRoot: options.dataRoot,
    principal: 'sys_shell',
  });
  const listeners = new Set<Listener>();
  return {
    port: {
      async ensureForAdoptedAgent(input) {
        const conversationId = conversationIdFor(input.agent.agentId);
        const title = titleFor(input.agent.provider, input.resumeId);
        const persisted = await setConversationView(conversationViewDriver, conversationId, {
          threadRef: null,
          address: `agent:${input.agent.agentId}`,
          pinned: false,
          archived: false,
          titleOverride: title,
          lastActivityAt: new Date().toISOString(),
          openedForPrincipalId: options.humanPrincipalId,
          membershipKind: 'direct',
          agentId: input.agent.agentId,
          provider: input.agent.provider,
        }, input.clientOpId);
        if (!persisted.ok) {
          throw new Error(
            `Conversation View ensure failed: ${persisted.error.code} ${persisted.error.message}`,
          );
        }
        const conversation: Conversation = {
          id: persisted.value.record.id,
          address: persisted.value.record.address ?? `agent:${input.agent.agentId}`,
          title: persisted.value.record.titleOverride ?? title,
          kind: 'agent',
          pinned: persisted.value.record.pinned,
          archived: persisted.value.record.archived,
          lastActivityAt: persisted.value.record.lastActivityAt,
          agentId: input.agent.agentId,
          provider: input.agent.provider,
          sessionId: input.sessionId,
        };
        for (const listener of listeners) listener(conversation);
        return { conversationId };
      },
      async ensureForAgentPair(input) {
        const participantIds = [...input.participantAgentIds].sort();
        const conversationId = pairConversationId(participantIds);
        const persisted = await setConversationView(conversationViewDriver, conversationId, {
          threadRef: null,
          pinned: false,
          archived: true,
          titleOverride: 'Agent communication',
          lastActivityAt: new Date().toISOString(),
          openedForPrincipalId: options.humanPrincipalId,
          membershipKind: 'group',
          participantIds,
        }, input.clientOpId);
        if (!persisted.ok) {
          throw new Error(
            `Agent pair Conversation View ensure failed: ${persisted.error.code} ${persisted.error.message}`,
          );
        }
        return { conversationId };
      },
    },
    subscribe(listener) {
      listeners.add(listener);
      return { close: () => listeners.delete(listener) };
    },
  };
}

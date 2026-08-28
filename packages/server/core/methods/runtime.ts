/** Shared runtime state and durable Conversation helpers for Server methods. */

import type {
  AgentsContract,
  KimiCliRuntime,
  ProviderCliRuntime,
  ProviderSessionRegistry,
} from '../../../agents/contract/index.js';
import { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import type { FocusSnapshot } from '../../../shell/contract/context.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { ServerConfig, ProviderName } from '../../contract/config.js';
import type { ConfigStore } from '../config/store.js';
import type { MessagingRuntimeApi } from '../../../messaging/contract/index.js';
import type { SupervisionEngine } from '../supervision/engine.js';
import type { WatchdogHook } from '../supervision/watchdog.js';
import type { B2aServerCapabilities } from '../b2a/composition.js';

type ShellPersistence = ReturnType<typeof composeShellPersistence>;

/** The running transcript-first Messaging runtime owned by this server. */
export interface MessagingRuntimeHost {
  readonly runtime: MessagingRuntimeApi;
}

export interface Conversation {
  id: string;
  threadId?: string;
  address: string;
  title: string;
  kind: 'agent' | 'room' | 'direct';
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  agentId?: string;
  lastReadMessageId?: string;
  sessionId?: string;
  personId?: string;
  provider?: ProviderName;
  unavailable?: {
    code: 'ConversationUnavailable';
    message: string;
  };
}

export interface ServerRuntime {
  root: string;
  cwd: string;
  human: { personId: string };
  agents: AgentsContract;
  kimiRuntime: KimiCliRuntime;
  providerRuntimes: Partial<Record<ProviderName, ProviderCliRuntime>>;
  sessions: ProviderSessionRegistry;
  supervision: SupervisionEngine;
  watchdog: WatchdogHook;
  b2a: B2aServerCapabilities;
  transcript: MessagingRuntimeHost;
  persistence: ShellPersistence;
  conversations: Map<string, Conversation>;
  configStore: ConfigStore;
  config: ServerConfig;
  focus: FocusSnapshot;
  broadcast(name: string, data: unknown): void;
  mintOpId(): string;
}

export const now = (): string => new Date().toISOString();

export const contextLine = (focus: unknown): string =>
  `[novakai context] ${JSON.stringify(focus)}`;

export const summarize = (conversation: Conversation) => ({
  id: conversation.id,
  threadId: conversation.threadId ?? conversation.address,
  title: conversation.title,
  kind: conversation.kind,
  pinned: conversation.pinned,
  archived: conversation.archived,
  lastActivityAt: conversation.lastActivityAt,
  agentId: conversation.agentId,
  lastReadMessageId: conversation.lastReadMessageId,
});

export async function persistView(
  runtime: ServerRuntime,
  conversation: Conversation,
  clientOpId: string,
): Promise<void> {
  const participant = conversation.agentId ?? conversation.personId ?? conversation.id;
  const result = await runtime.transcript.runtime.ensureConversationView({
    conversationId: conversation.id,
    participantIds: [runtime.human.personId, participant],
    clientOpId,
    address: conversation.address,
    pinned: conversation.pinned,
    archived: conversation.archived,
    lastActivityAt: conversation.lastActivityAt,
    titleOverride: conversation.title,
    ...(conversation.agentId ? { agentId: conversation.agentId } : {}),
    ...(conversation.provider ? { provider: conversation.provider } : {}),
    ...(conversation.lastReadMessageId
      ? { lastReadLineId: conversation.lastReadMessageId }
      : {}),
  });
  if (result.kind === 'error') {
    console.error(
      `[nvk-server] Conversation View persist failed for ${conversation.id}: ${result.error.message}`,
    );
  }
}

export function buildRuntimeMethods(runtime: ServerRuntime): MethodTable {
  return {
    async publishFocus(params: never) {
      runtime.focus = params as FocusSnapshot;
      for (const conversation of runtime.conversations.values()) {
        if (conversation.sessionId && conversation.provider === 'mock') {
          runtime.agents.pushContextAdvisory(
            conversation.sessionId as never,
            contextLine(runtime.focus),
          );
        }
      }
      return { ok: true };
    },
    async getFocus() {
      return runtime.focus;
    },
    async getCapabilities() {
      const config = runtime.configStore.current();
      const available = (provider: ProviderName): boolean =>
        runtime.providerRuntimes[provider]?.isAvailable() ?? false;
      return {
        protocol: 'nvk-ws v1',
        providers: {
          kimi: available('kimi'),
          claude: available('claude'),
          codex: available('codex'),
          mock: config.dev.allowMock,
        },
        realKimi: available('kimi'),
      };
    },
  };
}

/** Existing Agent-conversation and supervised-task spawn methods. */

import { randomUUID } from 'node:crypto';
import type { AgentsContract } from '../../../agents/contract/index.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { ProviderName } from '../../contract/config.js';
import { ensureAgent, ensureAgentPerson } from './provision.js';
import type { Conversation, ServerRuntime } from './runtime.js';
import { now, persistView, summarize } from './runtime.js';

/** Build the existing UI Agent-creation and supervised-task host methods. */
export function buildSpawnMethods(runtime: ServerRuntime): MethodTable {
  return {
    async spawnAgentConversation(params: never) {
      const input = (params ?? {}) as {
        title?: string;
        provider?: 'kimi' | 'claude' | 'codex' | 'mock';
        agentId?: string;
        conversationId?: string;
        clientOpId?: string;
      };
      if (input.agentId && input.provider) {
        return { ok: false as const, error: 'pass agentId OR provider, not both' };
      }
      if (input.conversationId !== undefined) {
        if (!/^conv_[A-Za-z0-9-]{4,64}$/.test(input.conversationId)) {
          return { ok: false as const, error: `invalid conversationId "${input.conversationId}"` };
        }
        if (runtime.conversations.has(input.conversationId)) {
          return { ok: false as const, error: `conversation "${input.conversationId}" already exists` };
        }
      }
      let provider: ProviderName;
      let title: string;
      let agentId: string;
      if (input.agentId) {
        const found = await runtime.agents.getAgent(input.agentId as never) as {
          ok: boolean;
          value?: { absent?: boolean; displayName?: string; provider?: ProviderName };
        };
        if (!found.ok || !found.value || found.value.absent || !found.value.provider) {
          return { ok: false as const, error: `no agent with id "${input.agentId}"` };
        }
        agentId = input.agentId;
        provider = found.value.provider;
        title = input.title?.trim()
          || found.value.displayName
          || `Agent ${runtime.conversations.size + 1}`;
        const existing = [...runtime.conversations.values()]
          .find((conversation) => conversation.agentId === agentId && !conversation.archived);
        if (existing) {
          return {
            ok: false as const,
            error: `agent already has conversation "${existing.title}" — open it instead`,
          };
        }
      } else {
        provider = input.provider ?? 'kimi';
        title = input.title?.trim() || `Agent ${runtime.conversations.size + 1}`;
        agentId = await ensureAgent(runtime, title, provider);
      }
      const personId = await ensureAgentPerson(runtime, agentId);
      const conversation: Conversation = {
        id: input.conversationId ?? `conv_${randomUUID().slice(0, 8)}`,
        address: `person:${personId}`,
        title,
        kind: 'agent',
        pinned: false,
        archived: false,
        lastActivityAt: now(),
        agentId,
        personId,
        provider,
      };
      runtime.conversations.set(conversation.id, conversation);
      await persistView(runtime, conversation, input.clientOpId ?? runtime.mintOpId());
      const summary = summarize(conversation);
      runtime.broadcast('conversation', summary);
      return { ok: true as const, conversation: summary };
    },

    async runSupervisedTask(params: never) {
      const input = (params ?? {}) as {
        clientOpId?: string;
        agentId?: string;
        agentDef?: Parameters<AgentsContract['defineAgent']>[0];
        taskBrief?: string;
        providerOpts?: Parameters<AgentsContract['spawnAgent']>[1];
      };
      if (!input.clientOpId || !input.taskBrief?.trim()
        || Boolean(input.agentId) === Boolean(input.agentDef)) {
        return {
          ok: false as const,
          error: {
            code: 'InvalidSupervisedTask',
            message: 'clientOpId, taskBrief, and exactly one of agentId/agentDef are required',
          },
        };
      }

      let agentId = input.agentId;
      if (input.agentDef) {
        const defined = await runtime.agents.defineAgent(input.agentDef, input.clientOpId as never) as {
          ok: boolean;
          value?: { id: string };
          error?: { code?: string; message?: string };
        };
        if (!defined.ok || !defined.value) {
          return {
            ok: false as const,
            error: {
              code: defined.error?.code ?? 'DefineAgentFailed',
              message: defined.error?.message ?? 'agent definition failed',
            },
          };
        }
        agentId = defined.value.id;
      } else {
        const found = await runtime.agents.getAgent(agentId! as never) as {
          ok: boolean;
          value?: { absent?: boolean };
          error?: { code?: string; message?: string };
        };
        if (!found.ok || found.value?.absent) {
          return {
            ok: false as const,
            error: {
              code: found.error?.code ?? 'AgentNotFound',
              message: found.error?.message ?? `no agent with id "${agentId}"`,
            },
          };
        }
      }

      const spawned = await runtime.agents.spawnAgent(
        agentId! as never,
        input.providerOpts,
        input.clientOpId as never,
      ) as {
        ok: boolean;
        value?: { sessionId: string; model: string; provider: ProviderName };
        error?: { code?: string; message?: string };
      };
      if (!spawned.ok || !spawned.value) {
        return {
          ok: false as const,
          error: {
            code: spawned.error?.code ?? 'SpawnFailed',
            message: spawned.error?.message ?? 'agent spawn failed',
          },
        };
      }
      const sessionId = spawned.value.sessionId;
      const cwd = input.providerOpts?.cwd ?? runtime.cwd;
      const registered = await runtime.sessions.register({
        sessionId,
        agentId: agentId!,
        provider: spawned.value.provider,
        cwd,
        model: spawned.value.model || 'cli-default',
      });
      if (!registered.ok) {
        runtime.agents.closeSession(sessionId as never);
        return {
          ok: false as const,
          error: { code: registered.error.code, message: registered.error.message },
        };
      }
      runtime.watchdog.register({
        sessionId,
        provider: spawned.value.provider,
        task: input.taskBrief,
        transcriptPath: null,
        cwd,
      });
      const outcome = await runtime.supervision.runSupervisedTask({
        sessionId,
        agentId: agentId!,
        brief: input.taskBrief,
        clientOpId: input.clientOpId,
      });
      if (!outcome.ok) {
        runtime.watchdog.close(sessionId);
        return outcome;
      }
      if (!outcome.taskComplete) return { ...outcome, terminated: false as const };
      const ended = await runtime.supervision.terminate(
        sessionId,
        'supervised task complete',
        input.clientOpId,
      );
      runtime.watchdog.close(sessionId);
      if (!ended.ok) return { ok: false as const, sessionId, error: ended.error };
      return { ...outcome, terminated: true as const };
    },
  };
}

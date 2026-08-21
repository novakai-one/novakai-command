// shell/ui/screens/messaging/benchCommands.ts — MessagesDesignCommands →
// ShellServices. Every state change flows through the contract with a fresh
// mintShellOpId (M1-05); every composer submission goes through readSlashInput
// (M1-09 — one parser, and it lives in contract/slashContinuity.ts, not here).
// Refusals are drawn as a local failed row on the card — visible, never sent
// as chat, never persisted.
import type {
  ChatMessage, ShellServices, SlashAnswer, SlashRegistry, SlashSituation,
} from '../../../contract/index.js';
import {
  mintShellOpId, readSlashInput, SHELL_SLASH_DOORS,
} from '../../../contract/index.js';
import type { MessagesDesignCommands, ObjectRecord } from '../../messages-designs/contract';
import { refusalRow, runBuiltinSlash } from './benchSlashBuiltins.js';
import type { BenchDataApi } from './useBenchData.js';
import { SELF_ID } from './useBenchData.js';

type SendOutcome = Awaited<ReturnType<ShellServices['sendMessage']>>;

const rejectedSendMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause;
  return 'The server rejected the send.';
};

/** RPC error frames reject; the interaction seam turns them back into typed UI data. */
async function sendMessageFromInteraction(
  services: ShellServices,
  conversationId: string,
  text: string,
  clientOpId: string,
): Promise<SendOutcome> {
  try {
    return await services.sendMessage(conversationId, text, clientOpId);
  } catch (cause) {
    return {
      ok: false,
      error: { code: 'SendRejected', message: rejectedSendMessage(cause) },
    };
  }
}

/** The UI resend path: the original key is mandatory and is never re-minted. */
export function resendFailedMessage(services: ShellServices, message: ChatMessage) {
  if (!message.clientOpId) {
    return Promise.resolve({
      ok: false as const,
      error: { code: 'MissingClientOpId', message: 'cannot safely resend without the original clientOpId' },
    });
  }
  return sendMessageFromInteraction(services, message.conversationId, message.text, message.clientOpId);
}

/** "New kimi agent" cards need a unique displayName: the server's ensureAgent
 * reuses a definition with the same name+provider, which would silently rebind
 * an existing agent (D22's mirror-thread trap). Count upward until free. */
function nextAgentTitle(api: BenchDataApi, provider: string): string {
  const base = provider.charAt(0).toUpperCase() + provider.slice(1);
  const taken = new Set(api.data.graph.byKind('agent').map((agent) => agent.title));
  let n = 1;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function createBenchCommands(props: {
  services: ShellServices;
  api: BenchDataApi;
  registry: SlashRegistry;
  onSelect(id: string | null): void;
}): MessagesDesignCommands {
  const { services, api, onSelect } = props;

  // The composer IS the Calm/Message surface (FZ-VIEW-032).
  const situation: SlashSituation = {
    surface: 'calm',
    holdsInputLease: false,
    providerDeclared: props.registry.declaredNames(),
    doors: SHELL_SLASH_DOORS,
  };

  const sendChat = async (conversationId: string, text: string) => {
    const clientOpId = mintShellOpId();
    const optimistic: ChatMessage = {
      id: `pending_${Date.now()}`,
      conversationId,
      senderId: SELF_ID,
      text,
      createdAt: new Date().toISOString(),
      pending: true,
      clientOpId,
    };
    api.appendLocal(optimistic); // pending drawn immediately (red gate 5)
    const res = await sendMessageFromInteraction(services, conversationId, text, clientOpId);
    api.settleLocal(conversationId, optimistic.id, res);
  };

  return {
    select(record: ObjectRecord | null): void {
      onSelect(record && record.kind === 'thread' ? record.id : null);
    },

    // Travel: the Bench is the only Room in this host. A conversation reveals
    // in place (select); every other kind refuses until its Room exists.
    canOpen: (record) => record.kind === 'thread',
    open(record): void {
      if (record.kind === 'thread') onSelect(record.id);
    },

    send(threadId: string, body: string): void {
      const answer: SlashAnswer = readSlashInput(body, situation);
      switch (answer.kind) {
        case 'message':
          void sendChat(threadId, answer.text);
          break;
        case 'novakai':
          void runBuiltinSlash({ services, api, onSelect }, threadId, body, answer.name, answer.args);
          break;
        case 'provider-control':
          // B3e's ShellAgentServices is read-only — no control door on this
          // host, so readSlashInput normally refuses before this branch. If a
          // door ever opens without a handler, refuse out loud (FZ-VIEW-032).
          api.appendLocal(refusalRow(threadId, body,
            `This host has no route for /${answer.control.name}, so nothing was sent.`,
            `Use: nvk agent control <agentRunId> --name ${answer.control.name} --value ${answer.control.value}`));
          break;
        case 'refused':
          api.appendLocal(refusalRow(threadId, body, answer.because, answer.instead));
          break;
        case 'unknown':
          api.appendLocal(refusalRow(threadId, body, answer.error.message,
            answer.error.details.suggestions.length
              ? `Try ${answer.error.details.suggestions.join(', ')}`
              : null));
          break;
        // raw-passthrough / raw-blocked cannot occur on the calm surface.
      }
    },

    // S2 (D30/D31): the draft picker's accept. The conversation id is minted
    // HERE, synchronously — the Bench keys placement by it from frame one and
    // the server adopts it, so no id ever swaps. The card appears optimistic
    // and the echo (same id) replaces it; a failed spawn explains itself with
    // a typed row and leaves nothing behind on reload.
    startConversation(agent: ObjectRecord): string {
      const conversationId = `conv_${globalThis.crypto.randomUUID()}`;
      const isNew = agent.id.startsWith('new:');
      const title = isNew ? nextAgentTitle(api, String(agent.fields.provider)) : agent.title;
      api.appendLocalConversation({
        id: conversationId, threadId: conversationId, title, kind: 'agent',
        pinned: false, archived: false, lastActivityAt: new Date().toISOString(),
        ...(isNew ? {} : { agentId: agent.id }),
      });
      const input = isNew
        ? { provider: agent.fields.provider as 'kimi' | 'claude' | 'codex' | 'mock', title, conversationId }
        : { agentId: agent.id, conversationId };
      void (async () => {
        if (!services.spawnAgentConversation) {
          api.appendLocal(refusalRow(conversationId, title, 'This host cannot spawn agent conversations.'));
          return;
        }
        try {
          const res = await services.spawnAgentConversation(input, mintShellOpId());
          if (!res.ok) {
            const reason = typeof res.error === 'string'
              ? res.error
              : (res.error.message ?? res.error.code);
            api.appendLocal(refusalRow(conversationId, `Start ${title}`, `Agent spawn failed: ${reason}`));
            return;
          }
          await api.refreshConversations();
        } catch (cause) {
          api.appendLocal(refusalRow(conversationId, `Start ${title}`,
            `Agent spawn failed: ${rejectedSendMessage(cause)}`));
        }
      })();
      return conversationId;
    },

    // D34: the failed row's affordance — SAME clientOpId, one committed post.
    resendMessage(threadId: string, messageId: string): void {
      const message = api.findMessage(threadId, messageId);
      if (!message?.failed) return;
      void resendFailedMessage(services, message)
        .then((res) => api.settleLocal(threadId, messageId, res));
    },

    // S3 (M3-01): the card menu's explicit "Mark read" — cursor to the newest
    // committed message. No messages → nothing to mark.
    markThreadRead(threadId: string): void {
      const latest = api.lastMessageId(threadId);
      if (!latest || !services.markConversationRead) return;
      void services.markConversationRead(threadId, latest, mintShellOpId())
        .then(() => api.refreshConversations());
    },

    archiveThread(threadId: string): void {
      void services.archiveConversation(threadId, true, mintShellOpId())
        .then(() => api.refreshConversations())
        .catch((cause) => api.appendLocal(refusalRow(threadId, 'Archive',
          `Not archived: ${rejectedSendMessage(cause)}`)));
    },

    unarchiveThread(threadId: string): void {
      void services.archiveConversation(threadId, false, mintShellOpId())
        .then(() => api.refreshConversations())
        .then(() => onSelect(threadId))
        .catch((cause) => api.appendLocal(refusalRow(threadId, 'Restore',
          `Not restored: ${rejectedSendMessage(cause)}`)));
    },

    pinThread(threadId: string, pinned: boolean): void {
      void services.pinConversation(threadId, pinned, mintShellOpId())
        .then(() => api.refreshConversations())
        .catch((cause) => api.appendLocal(refusalRow(threadId, pinned ? 'Pin' : 'Unpin',
          `Not saved: ${rejectedSendMessage(cause)}`)));
    },

    // Kill ≠ remove ≠ archive (Chris ruling 2026-08-21): this stops exactly
    // THIS conversation's live session — never a sweep over the agent's other
    // sessions. Nothing to stop, or a failed stop, is said out loud on the
    // card — never a silent no-op.
    killAgent(threadId: string): void {
      void (async () => {
        const conversation = api.conversations.find((convo) => convo.id === threadId);
        const sessionId = conversation?.sessionId;
        const sessions = services.sessions;
        if (!sessionId || !sessions) {
          api.appendLocal(refusalRow(threadId, 'Kill agent — nothing stopped',
            'No live session on this conversation.'));
          return;
        }
        const ended = await sessions.terminate(sessionId)
          .catch((cause) => ({ ok: false as const, error: cause }));
        if (!ended.ok) {
          api.appendLocal(refusalRow(threadId, 'Kill agent — the session did not stop',
            rejectedSendMessage(ended.error)));
          return;
        }
        await api.refreshConversations();
      })();
    },

    // No missions capability: the picker gates on byKind('mission'), which is
    // always empty, so this never runs.
    attachThreadToMission(): void {},

    // No requests capability: the graph never contains 'request' records, so
    // decision UI never mounts and this never runs.
    answerDecisionRequest(): string {
      return '';
    },
  };
}

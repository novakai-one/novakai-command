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
import type { BenchDataApi } from './useBenchData.js';
import { SELF_ID } from './useBenchData.js';

type SendOutcome = Awaited<ReturnType<ShellServices['sendMessage']>>;

const rejectedSendMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause;
  return 'The server rejected the send.';
};

/** RPC error frames reject; the interaction seam turns them back into typed UI data. */
export async function sendMessageFromInteraction(
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

/** A refusal drawn where the send would have appeared: local row, failed text,
 * nothing committed. The row is client-only and disappears on the next load. */
function refusalRow(conversationId: string, typed: string, because: string, instead?: string | null): ChatMessage {
  return {
    id: `refusal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    senderId: SELF_ID,
    text: typed,
    createdAt: new Date().toISOString(),
    failed: instead ? `${because} ${instead}` : because,
  };
}

/** "New kimi agent" cards need a unique displayName: the server's ensureAgent
 * reuses a definition with the same name+provider, which would silently rebind
 * an existing agent (D22's mirror-thread trap). Count upward until free. */
function nextAgentTitle(api: BenchDataApi, provider: string): string {
  const base = provider.charAt(0).toUpperCase() + provider.slice(1);
  const taken = new Set(api.data.graph.byKind('agent').map((a) => a.title));
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

  const runBuiltin = async (conversationId: string, typed: string, name: string, args: string) => {
    switch (name) {
      case 'new': {
        const c = await services.createConversation(args.trim() || 'New chat', 'agent', mintShellOpId());
        await api.refreshConversations();
        onSelect(c.id);
        break;
      }
      case 'pin': {
        const convo = api.conversations.find((c) => c.id === conversationId);
        await services.pinConversation(conversationId, !(convo?.pinned ?? false), mintShellOpId());
        await api.refreshConversations();
        break;
      }
      case 'archive': {
        const convo = api.conversations.find((c) => c.id === conversationId);
        await services.archiveConversation(conversationId, !(convo?.archived ?? false), mintShellOpId());
        await api.refreshConversations();
        break;
      }
      case 'unarchive': {
        // D39: the ported Bench model excludes archived conversations (canvas,
        // dock, search), so the way BACK is this door: bare = list, with an
        // argument = restore. The card returns at its old placement — canvas
        // memory never dropped it.
        const archived = api.conversations.filter((c) => c.archived);
        const wanted = args.trim().toLowerCase();
        if (!wanted) {
          api.appendLocal(refusalRow(conversationId, typed,
            archived.length
              ? `Archived: ${archived.map((c) => c.title).join(', ')}.`
              : 'No archived conversations.',
            archived.length ? 'Use: /unarchive <title>' : null));
          break;
        }
        const match = archived.find((c) => c.title.toLowerCase() === wanted || c.id === args.trim());
        if (!match) {
          api.appendLocal(refusalRow(conversationId, typed,
            `No archived conversation called "${args.trim()}".`,
            archived.length ? `Archived: ${archived.map((c) => c.title).join(', ')}` : null));
          break;
        }
        await services.archiveConversation(match.id, false, mintShellOpId());
        await api.refreshConversations();
        onSelect(match.id);
        break;
      }
      case 'theme':
        // The sandbox design system ships one theme; the setting still validates
        // but no longer changes the palette. Say so instead of pretending.
        api.appendLocal(refusalRow(conversationId, typed,
          'Themes left with the old design system — the app has one designed look now.'));
        break;
      case 'speed':
        // Named product removal: /speed went with the old screen. A silent
        // no-op here is the exact defect FZ-VIEW-032 exists to prevent.
        api.appendLocal(refusalRow(conversationId, typed,
          'The /speed render-speed setting was removed with the old Messages screen.'));
        break;
      default:
        api.appendLocal(refusalRow(conversationId, typed,
          `/${name} is reserved but has no handler on this screen, so nothing was sent.`));
    }
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
          void runBuiltin(threadId, body, answer.name, answer.args);
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
        .then(() => api.refreshConversations());
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

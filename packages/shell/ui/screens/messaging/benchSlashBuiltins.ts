// benchSlashBuiltins.ts — the /slash doors the Bench composer answers itself
// (moved verbatim from benchCommands.ts; M1-09 keeps the PARSER in
// contract/slashContinuity.ts — this file only handles already-parsed names).
// Refusals are drawn as a local failed row on the card — visible, never sent
// as chat, never persisted.
import type { ChatMessage, ShellServices } from '../../../contract/index.js';
import { mintShellOpId } from '../../../contract/index.js';
import type { BenchDataApi } from './useBenchData.js';
import { SELF_ID } from './useBenchData.js';

/** A refusal drawn where the send would have appeared: local row, failed text,
 * nothing committed. The row is client-only and disappears on the next load. */
export function refusalRow(
  conversationId: string, typed: string, because: string, instead?: string | null,
): ChatMessage {
  return {
    id: `refusal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    senderId: SELF_ID,
    text: typed,
    createdAt: new Date().toISOString(),
    failed: instead ? `${because} ${instead}` : because,
  };
}

/** Everything a builtin needs from the host: services, the data api, select. */
export type SlashBuiltinDeps = {
  readonly services: ShellServices;
  readonly api: BenchDataApi;
  readonly onSelect: (id: string | null) => void;
};

/** /unarchive — D39: archived conversations leave the canvas; the Library's
 * Archive section is the visible way back, and this door is the typed one. */
async function runUnarchiveSlash(
  deps: SlashBuiltinDeps, conversationId: string, typed: string, args: string,
): Promise<void> {
  const { services, api, onSelect } = deps;
  const archived = api.conversations.filter((convo) => convo.archived);
  const wanted = args.trim().toLowerCase();
  if (!wanted) {
    api.appendLocal(refusalRow(conversationId, typed,
      archived.length
        ? `Archived: ${archived.map((convo) => convo.title).join(', ')}.`
        : 'No archived conversations.',
      archived.length ? 'Use: /unarchive <title>' : null));
    return;
  }
  const match = archived.find((convo) => convo.title.toLowerCase() === wanted || convo.id === args.trim());
  if (!match) {
    api.appendLocal(refusalRow(conversationId, typed,
      `No archived conversation called "${args.trim()}".`,
      archived.length ? `Archived: ${archived.map((convo) => convo.title).join(', ')}` : null));
    return;
  }
  await services.archiveConversation(match.id, false, mintShellOpId());
  await api.refreshConversations();
  onSelect(match.id);
}

/** Runs one recognised /novakai builtin against the host services. */
export async function runBuiltinSlash(
  deps: SlashBuiltinDeps, conversationId: string, typed: string, name: string, args: string,
): Promise<void> {
  const { services, api, onSelect } = deps;
  switch (name) {
    case 'new': {
      const created = await services.createConversation(args.trim() || 'New chat', 'agent', mintShellOpId());
      await api.refreshConversations();
      onSelect(created.id);
      break;
    }
    case 'pin': {
      const convo = api.conversations.find((candidate) => candidate.id === conversationId);
      await services.pinConversation(conversationId, !(convo?.pinned ?? false), mintShellOpId());
      await api.refreshConversations();
      break;
    }
    case 'archive': {
      const convo = api.conversations.find((candidate) => candidate.id === conversationId);
      await services.archiveConversation(conversationId, !(convo?.archived ?? false), mintShellOpId());
      await api.refreshConversations();
      break;
    }
    case 'unarchive':
      await runUnarchiveSlash(deps, conversationId, typed, args);
      break;
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
}

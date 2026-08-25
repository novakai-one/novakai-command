// The Shell-owned side of §19.2's deliberate open.
//
// Messaging asks a `ConversationViewPort` rather than writing, because §18.1
// gives the `conversationView` kind to Shell. Production composed no port at
// all, so Messaging used the in-memory default written for "a headless host
// with no sidebar" — and every Novakai host silently became one. A pin died
// with the process that made it.
//
// This is the adapter between the two vocabularies, and it is deliberately thin:
// Messaging's `ConversationView` is what a caller asked for; Shell's
// `ConversationViewRecord` is what the sidebar durably holds. Neither type
// leaks into the other's package — the server composition root is the only
// place that knows both, which is what makes it the right place for this.
import type {
  ConversationView, ConversationViewPort,
} from '../../../messaging/contract/index.js';
import type { ThreadId } from '../../../messaging/contract/index.js';
import {
  listConversationViews, setConversationView, type ConversationViewRecord,
} from '../../../shell/contract/conversationView.js';
import { composeShellPersistence } from '../../../shell/contract/persistence.node.js';

/**
 * The shell conversation id for a Thread.
 *
 * Deterministic, so opening the same Thread twice updates one row instead of
 * growing a second — and so a restart finds the row again without an index.
 * Shell ids are `conv_…`; the Thread id is already opaque and unique.
 */
const conversationIdFor = (threadId: string): string =>
  `conv_${threadId.replace(/^thread_/, '')}`;

/** A stored row, read back as the thing Messaging asked for. */
function asView(record: ConversationViewRecord): ConversationView | null {
  const threadId = record.threadRef?.id;
  if (threadId === undefined) return null;
  return {
    threadId: threadId as ThreadId,
    openedForPrincipalId: record.openedForPrincipalId ?? record.createdBy,
    membershipKind: record.membershipKind ?? 'direct',
    // `archived` is Shell's word for "not in the sidebar right now". Closing a
    // Conversation archives the row rather than deleting it: §19.2's close is
    // "stop showing me this", not "forget it ever happened".
    open: !record.archived,
    openedAt: record.lastActivityAt,
  };
}

export function createFoundationConversationViews(options: {
  readonly root: string;
  readonly dataRoot: string;
}): ConversationViewPort {
  const { conversationViewDriver } = composeShellPersistence({
    root: options.root,
    dataRoot: options.dataRoot,
    principal: 'sys_shell',
  });

  return {
    async open(view) {
      await setConversationView(
        conversationViewDriver,
        conversationIdFor(view.threadId),
        {
          threadRef: { kind: 'thread', id: view.threadId },
          // The deliberate open IS the pin. §19.2 keeps inspection and opening
          // apart precisely so that this row means "Chris asked for this one".
          pinned: true,
          archived: false,
          openedForPrincipalId: view.openedForPrincipalId,
          membershipKind: view.membershipKind,
          lastActivityAt: view.openedAt,
        },
        `op_open_${conversationIdFor(view.threadId)}`,
      );
    },

    async close(threadId) {
      const id = conversationIdFor(threadId);
      const existing = await conversationViewDriver.get(id);
      if (existing === null) return; // closing what was never open is a no-op
      await setConversationView(conversationViewDriver, id, {
        pinned: false,
        archived: true,
        lastActivityAt: new Date().toISOString(),
      // A close is not idempotent the way an open is: closing twice is two
      // distinct acts against a row that already exists, and sharing one
      // clientOpId would make the second a swallowed replay of the first.
      }, `op_close_${id}_${String(existing.version)}`);
    },

    async list() {
      const records = await listConversationViews(conversationViewDriver);
      return records.map(asView).filter((view): view is ConversationView => view !== null);
    },
  };
}

export { conversationIdFor };

import { canonicalJson } from '@novakai/foundation/contract';
import type {
  ConversationView,
  ConversationViewMutation,
} from '../../contract/records/conversation-view.js';
import { MessagingError } from '../../contract/types.js';
import { compareStrings } from '../../core/compare.js';

interface PersistedConversationMutation {
  readonly sequence: number;
  readonly mutation: ConversationViewMutation;
}

type Persist = (mutation: ConversationViewMutation) => Promise<void>;

/** Two views are the same when their canonical encodings match — key order never decides. */
const equal = (left: ConversationView, right: ConversationView): boolean =>
  canonicalJson(left) === canonicalJson(right);

/** Owns idempotent Conversation View replacement and replay. */
export class ConversationViewState {
  private readonly views = new Map<string, ConversationView>();
  private readonly operations = new Map<string, ConversationView>();

  restore(items: readonly PersistedConversationMutation[]): void {
    for (const item of [...items].sort((left, right) => left.sequence - right.sequence)) {
      this.apply(item.mutation);
    }
  }

  async setView(mutation: ConversationViewMutation, persist: Persist): Promise<ConversationView> {
    const existing = this.operations.get(mutation.clientOpId);
    if (existing !== undefined) {
      if (!equal(existing, mutation.view)) {
        throw new MessagingError('IdempotencyConflict', {
          message: `Conversation operation ${mutation.clientOpId} conflicts`,
          fields: { clientOpId: mutation.clientOpId, conversationId: existing.id },
        });
      }
      return existing;
    }
    this.validate(mutation.view);
    await persist(mutation);
    this.apply(mutation);
    return mutation.view;
  }

  getView(id: string): ConversationView | null {
    return this.views.get(id) ?? null;
  }

  list(): readonly ConversationView[] {
    return [...this.views.values()].sort((left, right) =>
      compareStrings(left.createdAt, right.createdAt) || compareStrings(left.id, right.id));
  }

  private apply(mutation: ConversationViewMutation): void {
    this.operations.set(mutation.clientOpId, mutation.view);
    this.views.set(mutation.view.id, mutation.view);
  }

  /** Invariants the core enforces before the store; a breach here is a caller defect. */
  private validate(view: ConversationView): void {
    if (view.participantIds.length === 0 || new Set(view.participantIds).size !== view.participantIds.length) {
      throw new Error('Conversation View requires unique, non-empty participants');
    }
    const current = this.views.get(view.id);
    if (current !== undefined && current.createdAt !== view.createdAt) {
      throw new Error(`Conversation View ${view.id} cannot change createdAt`);
    }
  }
}

export type { PersistedConversationMutation };

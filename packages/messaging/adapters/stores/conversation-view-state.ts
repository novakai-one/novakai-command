import type {
  ConversationView,
  ConversationViewMutation,
} from '../../contract/records/conversation-view.js';

interface PersistedConversationMutation {
  readonly sequence: number;
  readonly mutation: ConversationViewMutation;
}

type Persist = (mutation: ConversationViewMutation) => Promise<void>;

const equal = (left: ConversationView, right: ConversationView): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Owns idempotent Conversation View replacement and replay. */
export class ConversationViewState {
  private readonly views = new Map<string, ConversationView>();
  private readonly operations = new Map<string, ConversationView>();

  restore(items: readonly PersistedConversationMutation[]): void {
    for (const item of [...items].sort((a, b) => a.sequence - b.sequence)) {
      this.apply(item.mutation);
    }
  }

  async set(mutation: ConversationViewMutation, persist: Persist): Promise<ConversationView> {
    const existing = this.operations.get(mutation.clientOpId);
    if (existing !== undefined) {
      if (!equal(existing, mutation.view)) {
        throw new Error(`Conversation operation ${mutation.clientOpId} conflicts`);
      }
      return existing;
    }
    this.validate(mutation.view);
    await persist(mutation);
    this.apply(mutation);
    return mutation.view;
  }

  get(id: string): ConversationView | null {
    return this.views.get(id) ?? null;
  }

  list(): readonly ConversationView[] {
    return [...this.views.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  private apply(mutation: ConversationViewMutation): void {
    this.operations.set(mutation.clientOpId, mutation.view);
    this.views.set(mutation.view.id, mutation.view);
  }

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

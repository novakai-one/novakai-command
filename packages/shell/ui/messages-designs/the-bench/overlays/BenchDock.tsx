import type { BenchConversation } from '../model/bench-model';
import './BenchDock.css';

/** Compact recency navigator; pills reveal cards without changing canvas order. */
export function BenchDock({
  conversations,
  openThreadIds,
  onReveal,
  onCreate,
  onSearch,
  onClearTrails,
}: {
  conversations: readonly BenchConversation[];
  openThreadIds: readonly string[];
  onReveal(threadId: string): void;
  onCreate(): void;
  onSearch(): void;
  onClearTrails(): void;
}) {
  return (
    <nav className="bench-dock" aria-label="Conversation dock">
      <button type="button" className="bench-dock__utility" onClick={onCreate} aria-label="New conversation">+</button>
      <button type="button" className="bench-dock__utility" onClick={onSearch} aria-label="Search conversations">⌕</button>
      <div className="bench-dock__conversations">
        {conversations.map((conversation) => (
          <button
            key={conversation.thread.id}
            type="button"
            data-open={openThreadIds.includes(conversation.thread.id)}
            onClick={() => onReveal(conversation.thread.id)}
            title={conversation.thread.title}
          >
            <span>{conversation.primaryParticipant?.initials ?? '—'}</span>
            <strong>{conversation.primaryParticipant?.record.title ?? conversation.thread.title}</strong>
            {conversation.unreadCount > 0 && <i>{conversation.unreadCount}</i>}
          </button>
        ))}
      </div>
      <button type="button" className="bench-dock__clear" onClick={onClearTrails}>Clear trails</button>
    </nav>
  );
}

import { useEffect, useRef } from 'react';
import type { BenchController } from '../model/useBenchController';
import './ConversationSearch.css';

/** Keyboard-first conversation finder over the shared Bench relational model. */
export function ConversationSearch({ controller }: { controller: BenchController }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <div className="bench-search" role="dialog" aria-modal="true" aria-label="Find a conversation">
      <div className="bench-search__panel">
        <label>
          <span className="bench-eyebrow">Find a conversation</span>
          <input
            ref={inputRef}
            value={controller.searchQuery}
            onChange={(event) => controller.setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') controller.closeSearch();
              if (event.key === 'Enter' && controller.searchResults[0]) {
                controller.revealConversation(controller.searchResults[0].conversation.thread.id);
              }
            }}
            placeholder="Agent, Mission, message or thread ID"
          />
        </label>
        <div className="bench-search__results">
          {controller.searchResults.map((result) => (
            <button
              type="button"
              className="bench-hover-wash"
              key={result.conversation.thread.id}
              onClick={() => controller.revealConversation(result.conversation.thread.id)}
            >
              <span>{result.conversation.primaryParticipant?.initials ?? '—'}</span>
              <strong>{result.conversation.primaryParticipant?.record.title ?? result.conversation.thread.title}</strong>
              <small>{result.conversation.mission?.record.title ?? 'Standalone'} · {result.matchedBy}</small>
            </button>
          ))}
          {controller.searchResults.length === 0 && <p>No conversations match that search.</p>}
        </div>
        <footer><kbd>Enter</kbd> reveal · <kbd>Esc</kbd> close</footer>
      </div>
    </div>
  );
}

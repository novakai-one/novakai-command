import type { BenchNodeActions } from '../model/bench-model';
import type { LibraryEntry } from './library-model';

/**
 * The per-conversation verb cluster — one component so cards, rows, and future
 * surfaces stay in step. Each verb is its own button and triggers nothing else
 * (kill ≠ remove ≠ archive, Chris ruling 2026-08-21).
 */
export function LibraryVerbs({ entry, actions }: {
  entry: LibraryEntry;
  actions: BenchNodeActions;
}) {
  const threadId = entry.threadId;
  return (
    <span className="library-verbs" role="group" aria-label={`Actions for ${entry.title}`}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          actions.pinConversation(threadId, !entry.pinned);
        }}
      >
        {entry.pinned ? 'Unpin' : 'Pin'}
      </button>
      {entry.onCanvas && (
        <button
          type="button"
          title="Take the card off the canvas — the conversation stays here"
          onClick={(event) => {
            event.stopPropagation();
            actions.shelveConversation(threadId);
          }}
        >
          Remove
        </button>
      )}
      {entry.liveSessionId !== null && (
        <button
          type="button"
          className="library-verbs__danger"
          title="Stop this agent's live session — the conversation stays"
          onClick={(event) => {
            event.stopPropagation();
            actions.killAgent(threadId);
          }}
        >
          Kill
        </button>
      )}
      <button
        type="button"
        title="Move to the Archive section at the bottom of this panel"
        onClick={(event) => {
          event.stopPropagation();
          actions.archiveConversation(threadId);
        }}
      >
        Archive
      </button>
    </span>
  );
}

import type { BenchNodeActions } from '../model/bench-model';
import { LibraryVerbs } from './LibraryVerbs';
import type { LibraryEntry } from './library-model';

const timeOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** A Today conversation at full size: identity, preview, time, verbs. */
export function LibraryCard({ entry, actions, onReveal }: {
  entry: LibraryEntry;
  actions: BenchNodeActions;
  onReveal: (threadId: string) => void;
}) {
  return (
    <div className="library-card" data-on-canvas={entry.onCanvas}>
      <button
        type="button"
        className="library-card__body"
        onClick={() => onReveal(entry.threadId)}
        aria-label={`Reveal ${entry.title} on the canvas`}
      >
        <span className="library-card__top">
          {entry.needsYou && <i className="library-needs-dot" aria-label="Needs you" />}
          <strong>{entry.title}</strong>
          <time>{timeOf(entry.lastActivityAt)}</time>
        </span>
        <span className="library-card__preview">
          {entry.preview || 'No messages yet.'}
        </span>
      </button>
      <LibraryVerbs entry={entry} actions={actions} />
    </div>
  );
}

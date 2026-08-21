import type { BenchNodeActions } from '../model/bench-model';
import { LibraryVerbs } from './LibraryVerbs';
import type { LibraryEntry } from './library-model';

const dayOf = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { weekday: 'short' });
};

/** One compact conversation line: who · preview · when, verbs on hover. */
export function LibraryRow({ entry, actions, onReveal, when }: {
  entry: LibraryEntry;
  actions: BenchNodeActions;
  onReveal: (threadId: string) => void;
  /** Override the trailing stamp (day stacks already say the day). */
  when?: string;
}) {
  return (
    <div className="library-row" data-on-canvas={entry.onCanvas}>
      <button
        type="button"
        className="library-row__body"
        onClick={() => onReveal(entry.threadId)}
        aria-label={`Reveal ${entry.title} on the canvas`}
      >
        {entry.needsYou && <i className="library-needs-dot" aria-label="Needs you" />}
        <strong>{entry.title}</strong>
        <span className="library-row__preview">{entry.preview}</span>
        <time>{when ?? dayOf(entry.lastActivityAt)}</time>
      </button>
      <LibraryVerbs entry={entry} actions={actions} />
    </div>
  );
}

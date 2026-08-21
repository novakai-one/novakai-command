import type { BenchNodeActions } from '../model/bench-model';
import { LibraryRow } from './LibraryRow';
import type { LibraryDayGroup } from './library-model';

/** One collapsed day of older conversations; opens on click. */
export function LibraryDayStack({ group, isOpen, onToggle, actions, onReveal }: {
  group: LibraryDayGroup;
  isOpen: boolean;
  onToggle: (key: string) => void;
  actions: BenchNodeActions;
  onReveal: (threadId: string) => void;
}) {
  return (
    <div className="library-stack" data-open={isOpen}>
      <button
        type="button"
        className="library-stack__head"
        aria-expanded={isOpen}
        onClick={() => onToggle(group.key)}
      >
        <span className="library-stack__chevron" aria-hidden="true">▸</span>
        <strong>{group.label}</strong>
        <span className="library-stack__count">
          {group.entries.length === 1 ? '1 conversation' : `${group.entries.length} conversations`}
        </span>
      </button>
      {isOpen && group.entries.map((entry) => (
        <LibraryRow
          key={entry.threadId}
          entry={entry}
          actions={actions}
          onReveal={onReveal}
          when=""
        />
      ))}
    </div>
  );
}

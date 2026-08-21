import type { BenchNodeActions } from '../model/bench-model';
import { LibraryCard } from './LibraryCard';
import { LibraryDayStack } from './LibraryDayStack';
import { LibraryRow } from './LibraryRow';
import { LibrarySection } from './LibrarySection';
import type { buildLibraryView } from './library-model';

type AgedView = ReturnType<typeof buildLibraryView>;

/** The default (no search) panel body: pinned, aged sections, archive. */
export function LibraryAgedView({ view, archiveOpen, onToggleArchive, openStackKeys, onToggleStack, actions, onReveal }: {
  view: AgedView;
  archiveOpen: boolean;
  onToggleArchive: (open: boolean) => void;
  openStackKeys: ReadonlySet<string>;
  onToggleStack: (key: string) => void;
  actions: BenchNodeActions;
  onReveal: (threadId: string) => void;
}) {
  return (
    <>
      {view.pinned.length > 0 && (
        <LibrarySection label="Pinned">
          {view.pinned.map((entry) => (
            <LibraryCard key={entry.threadId} entry={entry} actions={actions} onReveal={onReveal} />
          ))}
        </LibrarySection>
      )}
      {view.today.length > 0 && (
        <LibrarySection label="Today">
          {view.today.map((entry) => (
            <LibraryCard key={entry.threadId} entry={entry} actions={actions} onReveal={onReveal} />
          ))}
        </LibrarySection>
      )}
      {view.thisWeek.length > 0 && (
        <LibrarySection label="This week">
          {view.thisWeek.map((entry) => (
            <LibraryRow key={entry.threadId} entry={entry} actions={actions} onReveal={onReveal} />
          ))}
        </LibrarySection>
      )}
      {view.older.length > 0 && (
        <LibrarySection label="Older">
          {view.older.map((group) => (
            <LibraryDayStack
              key={group.key}
              group={group}
              isOpen={openStackKeys.has(group.key)}
              onToggle={onToggleStack}
              actions={actions}
              onReveal={onReveal}
            />
          ))}
        </LibrarySection>
      )}
      {view.archived.length > 0 && (
        <LibrarySection label="Archive" count={view.archived.length}>
          <button
            type="button"
            className="library-panel__archive-toggle"
            aria-expanded={archiveOpen}
            onClick={() => onToggleArchive(!archiveOpen)}
          >
            {archiveOpen ? 'Hide archived' : 'Show archived'}
          </button>
          {archiveOpen && view.archived.map((archived) => (
            <div key={archived.threadId} className="library-row" data-on-canvas={false}>
              <span className="library-row__body library-row__archived">
                <strong>{archived.title}</strong>
              </span>
              <span className="library-verbs">
                <button type="button" onClick={() => actions.unarchiveConversation(archived.threadId)}>
                  Restore
                </button>
              </span>
            </div>
          ))}
        </LibrarySection>
      )}
      {view.total === 0 && <p className="library-panel__empty">No conversations yet.</p>}
    </>
  );
}

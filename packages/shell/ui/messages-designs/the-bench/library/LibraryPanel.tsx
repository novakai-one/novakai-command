import { useEffect, useMemo, useRef } from 'react';
import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import { LibraryCard } from './LibraryCard';
import { LibraryDayStack } from './LibraryDayStack';
import { LibraryRow } from './LibraryRow';
import { LibrarySection } from './LibrarySection';
import { buildLibraryView, searchLibrary } from './library-model';
import { useLibraryPanel } from './useLibraryPanel';
import './library.css';
import './library-entries.css';

/**
 * The conversation Library: every conversation ever, aged so it stays clean —
 * pinned on top, today as cards, this week as rows, older as day stacks,
 * archive at the bottom. Collapsed it is one small row; expanded it floats
 * down the left edge of the canvas.
 */
export function LibraryPanel({
  conversations, archivedThreads, shelvedThreadIds, actions, onReveal, onCreate, searchSignal,
}: {
  conversations: readonly BenchConversation[];
  archivedThreads: readonly ObjectRecord[];
  shelvedThreadIds: readonly string[];
  actions: BenchNodeActions;
  onReveal: (threadId: string) => void;
  onCreate: () => void;
  /** Bumped by ⌘K — expands the panel and focuses search. */
  searchSignal: number;
}) {
  const panel = useLibraryPanel();
  const searchRef = useRef<HTMLInputElement>(null);
  const shelved = useMemo(() => new Set(shelvedThreadIds), [shelvedThreadIds]);
  const view = useMemo(
    () => buildLibraryView({ conversations, archivedThreads, shelvedThreadIds: shelved, now: new Date() }),
    [conversations, archivedThreads, shelved],
  );
  const results = useMemo(
    () => searchLibrary(conversations, shelved, panel.query),
    [conversations, shelved, panel.query],
  );

  const { setExpanded } = panel;
  useEffect(() => {
    if (searchSignal === 0) return undefined;
    setExpanded(true);
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [searchSignal, setExpanded]);

  if (!panel.expanded) {
    return (
      <button
        type="button"
        className="library-collapsed"
        onClick={() => panel.setExpanded(true)}
        aria-label={`Open the conversation library (${view.total} conversations)`}
      >
        {view.needsYouCount > 0 && <i className="library-needs-dot" aria-label={`${view.needsYouCount} need you`} />}
        <strong>Library</strong>
        <span>{view.total}</span>
      </button>
    );
  }

  const searching = panel.query.trim().length > 0;
  return (
    <aside className="library-panel" style={{ width: panel.width }} aria-label="Conversation library">
      <header className="library-panel__head">
        <strong>Library</strong>
        <span className="library-panel__count">{view.total}</span>
        <button type="button" className="bench-icon-control" onClick={onCreate} aria-label="New conversation">+</button>
        <button
          type="button"
          className="bench-icon-control"
          onClick={() => panel.setExpanded(false)}
          aria-label="Collapse the library"
        >
          ‹
        </button>
      </header>
      <input
        ref={searchRef}
        className="library-panel__search"
        value={panel.query}
        placeholder="Search conversations…"
        onChange={(event) => panel.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (panel.query) panel.setQuery('');
          else panel.setExpanded(false);
        }}
      />
      <div className="library-panel__body">
        {searching ? (
          <LibrarySection label="Matches" count={results.length}>
            {results.map((entry) => (
              <LibraryRow key={entry.threadId} entry={entry} actions={actions} onReveal={onReveal} />
            ))}
            {results.length === 0 && <p className="library-panel__empty">No conversations match.</p>}
          </LibrarySection>
        ) : (
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
                    isOpen={panel.openStackKeys.has(group.key)}
                    onToggle={panel.toggleStack}
                    actions={actions}
                    onReveal={onReveal}
                  />
                ))}
              </LibrarySection>
            )}
            {view.archived.length > 0 && (
              <LibrarySection label="Archive" count={view.archived.length}>
                {panel.archiveOpen ? view.archived.map((archived) => (
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
                )) : (
                  <button
                    type="button"
                    className="library-panel__archive-toggle"
                    onClick={() => panel.setArchiveOpen(true)}
                  >
                    Show archived
                  </button>
                )}
              </LibrarySection>
            )}
            {view.total === 0 && <p className="library-panel__empty">No conversations yet.</p>}
          </>
        )}
      </div>
      <div
        className="library-panel__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the library"
        onPointerDown={panel.startResize}
      />
    </aside>
  );
}

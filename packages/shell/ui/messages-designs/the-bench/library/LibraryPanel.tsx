import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';
import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import { LibraryAgedView } from './LibraryAgedView';
import { LibraryRow } from './LibraryRow';
import { LibrarySection } from './LibrarySection';
import { buildLibraryView, searchLibrary } from './library-model';
import { useLibraryPanel } from './useLibraryPanel';
import './library.css';
import './library-entries.css';

/** The one-row collapsed state: name, count, and the amber needs-you dot. */
function CollapsedLibrary({ total, needsYouCount, onOpen }: {
  total: number;
  needsYouCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="library-collapsed"
      onClick={onOpen}
      aria-label={`Open the conversation library (${total} conversations)`}
    >
      {needsYouCount > 0 && <i className="library-needs-dot" aria-label={`${needsYouCount} need you`} />}
      <strong>Library</strong>
      <span>{total}</span>
    </button>
  );
}

/** The panel's search input; Escape clears, a second Escape collapses. */
function LibrarySearchInput({ panel, searchRef }: {
  panel: ReturnType<typeof useLibraryPanel>;
  searchRef: React.RefObject<HTMLInputElement>;
}) {
  return (
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
  );
}

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
      <CollapsedLibrary
        total={view.total}
        needsYouCount={view.needsYouCount}
        onOpen={() => panel.setExpanded(true)}
      />
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
      <LibrarySearchInput panel={panel} searchRef={searchRef} />
      <div className="library-panel__body">
        {searching ? (
          <LibrarySection label="Matches" count={results.length}>
            {results.map((entry) => (
              <LibraryRow key={entry.threadId} entry={entry} actions={actions} onReveal={onReveal} />
            ))}
            {results.length === 0 && <p className="library-panel__empty">No conversations match.</p>}
          </LibrarySection>
        ) : (
          <LibraryAgedView
            view={view}
            archiveOpen={panel.archiveOpen}
            onOpenArchive={() => panel.setArchiveOpen(true)}
            openStackKeys={panel.openStackKeys}
            onToggleStack={panel.toggleStack}
            actions={actions}
            onReveal={onReveal}
          />
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

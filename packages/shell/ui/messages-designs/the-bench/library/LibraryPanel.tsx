import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import { LibraryAgedView } from './LibraryAgedView';
import { buildLibraryView, matchesLibraryQuery } from './library-model';
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

/** Re-renders the aged view when the local calendar day turns over. */
function useLocalDayTick(): number {
  const [dayTick, setDayTick] = useState(0);
  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setDayTick((tick) => tick + 1), nextMidnight.getTime() - now.getTime() + 1000);
    return () => clearTimeout(timer);
  }, [dayTick]);
  return dayTick;
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
  const dayTick = useLocalDayTick();
  const shelved = useMemo(() => new Set(shelvedThreadIds), [shelvedThreadIds]);
  const query = panel.query.trim();
  const searching = query.length > 0;
  // Search keeps the aged sections: filter the inputs, re-age what remains.
  const view = useMemo(() => {
    const matching = searching
      ? conversations.filter((conversation) => matchesLibraryQuery(conversation, query))
      : conversations;
    const matchingArchived = searching
      ? archivedThreads.filter((thread) => thread.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
      : archivedThreads;
    return buildLibraryView({
      conversations: matching, archivedThreads: matchingArchived,
      shelvedThreadIds: shelved, now: new Date(),
    });
    // dayTick: the sections re-age when local midnight passes.
  }, [conversations, archivedThreads, shelved, searching, query, dayTick]);
  // While searching, every matching day stack is open and the archive shows.
  const openStackKeys = useMemo(
    () => (searching ? new Set(view.older.map((group) => group.key)) : panel.openStackKeys),
    [searching, view.older, panel.openStackKeys],
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
        <LibraryAgedView
          view={view}
          archiveOpen={searching || panel.archiveOpen}
          onToggleArchive={panel.setArchiveOpen}
          openStackKeys={openStackKeys}
          onToggleStack={panel.toggleStack}
          actions={actions}
          onReveal={onReveal}
        />
        {searching && view.total === 0 && view.archived.length === 0 && (
          <p className="library-panel__empty">No conversations match.</p>
        )}
      </div>
      <div
        className="library-panel__resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize the library"
        aria-valuemin={280}
        aria-valuemax={560}
        aria-valuenow={panel.width}
        onPointerDown={panel.startResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') panel.nudgeWidth(-16);
          if (event.key === 'ArrowRight') panel.nudgeWidth(16);
        }}
      />
    </aside>
  );
}

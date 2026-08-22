import { ChevronDown, ChevronUp, Filter, Plus, Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ConversationInstrumentProps } from './contract';
import { ConversationItem } from './ConversationItem';
import { ConversationSection } from './ConversationSection';
import { useConversationInstrumentView } from './useConversationInstrumentView';
import './conversation-instrument.css';
import './conversation-inventory.css';
import './conversation-item.css';

export function ConversationInstrument({
  sources,
  selectedThreadId,
  trailCount,
  onAction,
  onCreate,
  onClearTrails,
}: ConversationInstrumentProps) {
  const state = useConversationInstrumentView(sources, selectedThreadId);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      state.setOpen(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [state.setOpen]);

  return (
    <aside className="conversation-instrument" data-open={state.isOpen} aria-label="Conversation navigator">
      <header className="conversation-instrument__header">
        <span className="conversation-instrument__heading">
          <strong>Conversations</strong>
          <small>Canvas navigator</small>
        </span>
        <button type="button" className="conversation-instrument__new" onClick={onCreate}>
          <Plus size={14} aria-hidden="true" /> New
        </button>
        <button
          type="button"
          className="conversation-instrument__collapse"
          onClick={() => state.setOpen(!state.isOpen)}
          aria-expanded={state.isOpen}
          aria-controls="conversation-instrument-body"
          aria-label={state.isOpen ? 'Roll up conversations' : 'Open conversations'}
        >
          {state.isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </header>

      <div id="conversation-instrument-body" className="conversation-instrument__body" hidden={!state.isOpen}>
        <label className="conversation-instrument__search">
          <Search size={15} aria-hidden="true" />
          <span className="conversation-instrument__sr-only">Search conversations</span>
          <input
            ref={searchRef}
            type="search"
            value={state.query}
            onChange={(event) => state.setQuery(event.target.value)}
            placeholder="Search conversations"
            autoComplete="off"
          />
          <kbd>⌘K</kbd>
        </label>

        <div className="conversation-instrument__controls">
          <label>
            <span>Group</span>
            <select value={state.groupBy} onChange={(event) => state.setGroupBy(event.target.value as typeof state.groupBy)}>
              <option value="date">Date</option>
              <option value="project">Project</option>
              <option value="mission">Mission</option>
              <option value="task">Task</option>
              <option value="canvas">On canvas</option>
              <option value="none">None</option>
            </select>
          </label>
          <label>
            <span>Order</span>
            <select value={state.order} onChange={(event) => state.setOrder(event.target.value as typeof state.order)}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </label>
          <button
            type="button"
            className="conversation-instrument__filter"
            data-active={state.hasActiveFilters}
            onClick={() => state.setFiltersOpen(!state.filtersOpen)}
            aria-expanded={state.filtersOpen}
          >
            <Filter size={14} aria-hidden="true" /> Filter
          </button>
        </div>

        {state.filtersOpen && (
          <div className="conversation-instrument__filters">
            <label><span>Activity</span><select value={state.dateFilter} onChange={(event) => state.setDateFilter(event.target.value as typeof state.dateFilter)}>
              <option value="any">Any time</option><option value="seven-days">Last 7 days</option>
              <option value="thirty-days">Last 30 days</option><option value="this-year">This year</option>
            </select></label>
            <label><span>Related work</span><select value={state.relationId} onChange={(event) => state.setRelationId(event.target.value)}>
              <option value="">All work</option>
              {state.relationOptions.map((option) => <option value={option.id} key={option.id}>{option.kind} · {option.label}</option>)}
            </select></label>
            {state.hasActiveFilters && <button type="button" onClick={state.clearFilters}>Clear</button>}
          </div>
        )}

        <div className="conversation-instrument__collection">
          {state.sections.map((section) => (
            <ConversationSection
              section={section}
              collapsed={state.collapsedSectionIds.has(section.id)}
              onToggle={() => state.toggleSection(section.id)}
              key={section.id}
            >
              {section.items.map((item) => (
                <ConversationItem
                  item={item}
                  expanded={state.expandedThreadId === item.threadId}
                  onSelect={() => onAction({ kind: 'select', threadId: item.threadId })}
                  onToggle={() => state.toggleRow(item.threadId)}
                  onAction={onAction}
                  key={item.threadId}
                />
              ))}
            </ConversationSection>
          ))}
          {state.view.emptyReason && <div className="conversation-instrument__empty"><strong>{state.query || state.hasActiveFilters ? 'No conversations match this view.' : 'No conversations yet.'}</strong></div>}
        </div>

        <footer className="conversation-instrument__footer">
          <span>{state.view.visibleCount} of {state.view.totalCount} conversations</span>
          {trailCount > 0 && <button type="button" onClick={onClearTrails}>Clear {trailCount} trails</button>}
        </footer>
      </div>
    </aside>
  );
}

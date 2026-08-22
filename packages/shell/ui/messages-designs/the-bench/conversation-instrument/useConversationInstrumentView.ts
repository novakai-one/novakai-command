import { useEffect, useMemo, useState } from 'react';
import type {
  ConversationDateFilter,
  ConversationGroupBy,
  ConversationInstrumentSource,
  ConversationOrder,
} from './contract';
import {
  conversationRelationOptions,
  projectConversationInstrument,
} from './model';
import { partitionConversationItems, sectionRecipeFor } from './sections';

const DEFAULT_GROUP: ConversationGroupBy = 'date';

/** Owns local navigator presentation without mirroring canvas or graph state. */
export function useConversationInstrumentView(
  sources: readonly ConversationInstrumentSource[],
  selectedThreadId: string | null,
) {
  const [isOpen, setOpen] = useState(true);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<ConversationGroupBy>(DEFAULT_GROUP);
  const [order, setOrder] = useState<ConversationOrder>('newest');
  const [relationId, setRelationId] = useState('');
  const [dateFilter, setDateFilter] = useState<ConversationDateFilter>('any');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedThreadId, setExpandedThreadId] = useState<string | null>(null);
  const [collapsedSectionIds, setCollapsedSectionIds] = useState<ReadonlySet<string>>(new Set());

  const relationOptions = useMemo(() => conversationRelationOptions(sources), [sources]);
  const validRelationIds = useMemo(
    () => new Set(relationOptions.map((option) => option.id)),
    [relationOptions],
  );
  useEffect(() => {
    if (relationId && !validRelationIds.has(relationId)) setRelationId('');
  }, [relationId, validRelationIds]);

  const options = useMemo(() => ({
    query,
    groupBy,
    order,
    relationId,
    dateFilter,
  }), [dateFilter, groupBy, order, query, relationId]);
  const view = useMemo(
    () => projectConversationInstrument(sources, selectedThreadId, options),
    [options, selectedThreadId, sources],
  );
  const sections = useMemo(
    () => partitionConversationItems(view.items, sectionRecipeFor(groupBy, view.items)),
    [groupBy, view.items],
  );

  return {
    isOpen,
    setOpen,
    query,
    setQuery,
    groupBy,
    setGroupBy,
    order,
    setOrder,
    relationId,
    setRelationId,
    dateFilter,
    setDateFilter,
    filtersOpen,
    setFiltersOpen,
    hasActiveFilters: Boolean(relationId || dateFilter !== 'any'),
    relationOptions,
    view,
    sections,
    expandedThreadId,
    toggleRow: (threadId: string) => {
      setExpandedThreadId((current) => current === threadId ? null : threadId);
    },
    collapsedSectionIds,
    toggleSection: (sectionId: string) => {
      setCollapsedSectionIds((current) => {
        const next = new Set(current);
        if (next.has(sectionId)) next.delete(sectionId);
        else next.add(sectionId);
        return next;
      });
    },
    clearFilters: () => {
      setRelationId('');
      setDateFilter('any');
    },
  } as const;
}

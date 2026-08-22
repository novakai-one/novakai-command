import type {
  ConversationCanvasState,
  ConversationInstrumentId,
  ConversationInstrumentSource,
  ConversationInstrumentViewOptions,
  ConversationRelationKind,
  ConversationRelationSource,
} from './contract';

export type ConversationInstrumentItem = {
  readonly threadId: ConversationInstrumentId;
  readonly title: string;
  readonly initials: string;
  readonly personLabel: string | null;
  readonly personStatus: string | null;
  readonly relations: readonly ConversationRelationSource[];
  readonly excerpt: string;
  readonly lastActivityAt: string;
  readonly activityLabel: string;
  readonly unreadCount: number;
  readonly blocked: boolean;
  readonly selected: boolean;
  readonly canvasState: ConversationCanvasState;
  readonly canRemove: boolean;
};

export type ConversationInstrumentView = {
  readonly items: readonly ConversationInstrumentItem[];
  readonly totalCount: number;
  readonly visibleCount: number;
  readonly emptyReason: 'no-threads' | 'no-results' | null;
};

export type ConversationRelationOption = {
  readonly id: string;
  readonly label: string;
  readonly kind: ConversationRelationKind;
};

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timestampOf(value: string): number {
  return validDate(value)?.getTime() ?? 0;
}

function searchableDates(source: ConversationInstrumentSource): string[] {
  const values = [
    source.createdAt,
    source.lastActivityAt,
    ...source.messages.map((message) => message.createdAt),
  ];
  return values.flatMap((value) => {
    const date = validDate(value);
    if (!date) return [value];
    return [
      value,
      new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium' }).format(date),
      new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(date),
    ];
  });
}

function activityLabel(value: string, now: Date): string {
  const date = validDate(value);
  if (!date) return '';
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const valueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDifference = Math.round((dayStart - valueDay) / 86_400_000);
  if (dayDifference === 0) {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  }
  if (dayDifference === 1) return 'Yesterday';
  if (dayDifference > 1 && dayDifference < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(date);
  }
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' }).format(date);
}

function latestMessage(source: ConversationInstrumentSource) {
  return [...source.messages].sort((left, right) => (
    timestampOf(right.createdAt) - timestampOf(left.createdAt)
    || left.messageId.localeCompare(right.messageId)
  ))[0];
}

function sameLabel(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function itemFor(
  source: ConversationInstrumentSource,
  selectedThreadId: ConversationInstrumentId | null,
  now: Date,
): ConversationInstrumentItem {
  const primaryPerson = source.people[0] ?? null;
  const title = source.title.trim() || 'Untitled conversation';
  return {
    threadId: source.threadId,
    title,
    initials: primaryPerson?.initials || '—',
    personLabel: primaryPerson && !sameLabel(primaryPerson.label, title) ? primaryPerson.label : null,
    personStatus: primaryPerson?.status ?? null,
    relations: source.relations,
    excerpt: latestMessage(source)?.body.trim() || 'No messages yet',
    lastActivityAt: source.lastActivityAt,
    activityLabel: activityLabel(source.lastActivityAt, now),
    unreadCount: Math.max(0, source.unreadCount),
    blocked: source.blocked,
    selected: source.threadId === selectedThreadId,
    canvasState: source.canvasState,
    canRemove: source.canRemove,
  };
}

function searchText(source: ConversationInstrumentSource): string {
  return [
    source.threadId,
    source.title,
    ...source.people.flatMap((person) => [person.personId, person.label]),
    ...source.relations.flatMap((relation) => [
      relation.relationId,
      relation.kind,
      relation.label,
      relation.relation,
    ]),
    ...source.messages.flatMap((message) => [message.messageId, message.body]),
    ...searchableDates(source),
  ].join(' ').toLocaleLowerCase();
}

function passesDateFilter(
  source: ConversationInstrumentSource,
  filter: ConversationInstrumentViewOptions['dateFilter'],
  now: Date,
): boolean {
  if (filter === 'any') return true;
  const activity = validDate(source.lastActivityAt);
  if (!activity) return false;
  if (filter === 'this-year') return activity.getFullYear() === now.getFullYear();
  const elapsed = now.getTime() - activity.getTime();
  const dayLimit = filter === 'seven-days' ? 7 : 30;
  return elapsed >= 0 && elapsed <= dayLimit * 86_400_000;
}

/** Returns the relation choices supported by the current plain catalogue. */
export function conversationRelationOptions(
  sources: readonly ConversationInstrumentSource[],
): ConversationRelationOption[] {
  const options = new Map<string, ConversationRelationOption>();
  for (const relation of sources.flatMap((source) => source.relations)) {
    options.set(relation.relationId, {
      id: relation.relationId,
      label: relation.label,
      kind: relation.kind,
    });
  }
  return [...options.values()].sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label)
  ));
}

/** Projects one stable inventory; selection and membership never command the canvas. */
export function projectConversationInstrument(
  sources: readonly ConversationInstrumentSource[],
  selectedThreadId: ConversationInstrumentId | null,
  options: ConversationInstrumentViewOptions,
  now = new Date(),
): ConversationInstrumentView {
  const normalizedQuery = options.query.trim().toLocaleLowerCase();
  const direction = options.order === 'newest' ? -1 : 1;
  const items = sources
    .filter((source) => !normalizedQuery || searchText(source).includes(normalizedQuery))
    .filter((source) => passesDateFilter(source, options.dateFilter, now))
    .filter((source) => (
      !options.relationId
      || source.relations.some((relation) => relation.relationId === options.relationId)
    ))
    .map((source) => itemFor(source, selectedThreadId, now))
    .sort((left, right) => (
      direction * (timestampOf(left.lastActivityAt) - timestampOf(right.lastActivityAt))
      || left.title.localeCompare(right.title)
      || left.threadId.localeCompare(right.threadId)
    ));

  return {
    items,
    totalCount: sources.length,
    visibleCount: items.length,
    emptyReason: sources.length === 0 ? 'no-threads' : items.length === 0 ? 'no-results' : null,
  };
}

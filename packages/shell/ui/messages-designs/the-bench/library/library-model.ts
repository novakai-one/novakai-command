import type { ObjectId, ObjectRecord } from '../../contract';
import type { BenchConversation } from '../model/bench-model';

/** One conversation prepared for a Library card, row, or stack line. */
export type LibraryEntry = {
  readonly threadId: ObjectId;
  readonly title: string;
  readonly initials: string;
  readonly status: string;
  readonly preview: string;
  readonly lastActivityAt: string;
  /** Amber signal: something in this conversation needs Chris now. */
  readonly needsYou: boolean;
  readonly unreadCount: number;
  readonly pinned: boolean;
  readonly onCanvas: boolean;
  readonly conversation: BenchConversation;
};

/** One collapsed day of older conversations. */
export type LibraryDayGroup = {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly LibraryEntry[];
};

/** One archived conversation — title only; restore brings the rest back. */
type LibraryArchivedEntry = {
  readonly threadId: ObjectId;
  readonly title: string;
};

/** The complete aged view the panel renders. Empty sections are simply empty. */
type LibraryView = {
  readonly pinned: readonly LibraryEntry[];
  readonly today: readonly LibraryEntry[];
  readonly thisWeek: readonly LibraryEntry[];
  readonly older: readonly LibraryDayGroup[];
  readonly archived: readonly LibraryArchivedEntry[];
  readonly needsYouCount: number;
  readonly total: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const localDayKey = (date: Date): string => (
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
);

const dayLabel = (date: Date): string => date.toLocaleDateString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short',
});

function entryFor(conversation: BenchConversation, shelved: ReadonlySet<string>): LibraryEntry {
  const participant = conversation.primaryParticipant;
  return {
    threadId: conversation.thread.id,
    title: participant?.record.title ?? conversation.thread.title,
    initials: participant?.initials ?? '—',
    status: participant?.status ?? 'unknown',
    preview: conversation.previewLines.at(-1) ?? '',
    lastActivityAt: conversation.lastActivityAt,
    needsYou: conversation.unreadCount > 0 || conversation.isBlocked,
    unreadCount: conversation.unreadCount,
    pinned: conversation.thread.fields.pinned === true,
    onCanvas: !shelved.has(conversation.thread.id),
    conversation,
  };
}

/** Groups conversations into the aged panel view. Pure — `now` is injected. */
export function buildLibraryView(input: {
  readonly conversations: readonly BenchConversation[];
  readonly archivedThreads: readonly ObjectRecord[];
  readonly shelvedThreadIds: ReadonlySet<string>;
  readonly now: Date;
}): LibraryView {
  const entries = input.conversations
    .map((conversation) => entryFor(conversation, input.shelvedThreadIds))
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));

  const todayKey = localDayKey(input.now);
  const weekFloor = input.now.getTime() - 7 * DAY_MS;
  const pinned: LibraryEntry[] = [];
  const today: LibraryEntry[] = [];
  const thisWeek: LibraryEntry[] = [];
  const olderByDay = new Map<string, { label: string; entries: LibraryEntry[] }>();

  for (const entry of entries) {
    if (entry.pinned) {
      pinned.push(entry);
      continue;
    }
    const activity = new Date(entry.lastActivityAt);
    const activityKey = localDayKey(activity);
    if (activityKey === todayKey) {
      today.push(entry);
    } else if (activity.getTime() >= weekFloor) {
      thisWeek.push(entry);
    } else {
      const group = olderByDay.get(activityKey) ?? { label: dayLabel(activity), entries: [] };
      group.entries.push(entry);
      olderByDay.set(activityKey, group);
    }
  }

  return {
    pinned,
    today,
    thisWeek,
    older: [...olderByDay.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([key, group]) => ({ key, label: group.label, entries: group.entries })),
    archived: input.archivedThreads
      .map((thread) => ({ threadId: thread.id, title: thread.title }))
      .sort((left, right) => left.title.localeCompare(right.title)),
    needsYouCount: entries.filter((entry) => entry.needsYou).length,
    total: entries.length,
  };
}

/** Live filter across title, participants, mission, and message text. */
export function searchLibrary(
  conversations: readonly BenchConversation[],
  shelvedThreadIds: ReadonlySet<string>,
  query: string,
): readonly LibraryEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return conversations
    .filter((conversation) => (
      `${conversation.thread.title} ${conversation.thread.id}`.toLocaleLowerCase().includes(normalized)
      || conversation.participants.some((participant) => (
        participant.record.title.toLocaleLowerCase().includes(normalized)
      ))
      || conversation.mission?.record.title.toLocaleLowerCase().includes(normalized)
      || conversation.messages.some((message) => message.body.toLocaleLowerCase().includes(normalized))
    ))
    .map((conversation) => entryFor(conversation, shelvedThreadIds))
    .sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
}

import type {
  BenchAction,
  BenchSessionSnapshot,
  BenchState,
} from './bench-model';
import { reconcileInspectionTrails, reduceInspectionTrails } from './bench-trails';

/** Creates the empty semantic session used on a first visit. */
function createEmptyBenchSession(): BenchSessionSnapshot {
  return {
    openThreadIds: [],
    shelvedThreadIds: [],
    trails: [],
    frames: [],
    scrollTopByThreadId: {},
    focusedThreadId: null,
    pendingDraft: null,
  };
}

/** Creates reducer state from remembered semantics and an optional routed thread. */
export function createInitialBenchState(
  snapshot: BenchSessionSnapshot | null,
  initialThreadId?: string,
): BenchState {
  const session = snapshot ?? createEmptyBenchSession();
  const openThreadIds = initialThreadId && !session.openThreadIds.includes(initialThreadId)
    ? [...session.openThreadIds, initialThreadId]
    : [...session.openThreadIds];

  return {
    session: {
      ...session,
      openThreadIds,
      // A routed thread must be visible even if it was shelved last session.
      shelvedThreadIds: session.shelvedThreadIds.filter((id) => id !== initialThreadId),
      trails: session.trails.map((trail) => ({
        ...trail,
        steps: trail.steps.map((step) => ({ ...step })),
      })),
      frames: session.frames.map((frame) => ({
        ...frame,
        conversationIds: [...frame.conversationIds],
      })),
      scrollTopByThreadId: { ...session.scrollTopByThreadId },
      pendingDraft: session.pendingDraft ? { ...session.pendingDraft } : null,
    },
    zoomTier: 'mid',
  };
}

function setFrameMembership(
  session: BenchSessionSnapshot,
  threadId: string,
  frameId: string | null,
): BenchSessionSnapshot {
  return {
    ...session,
    frames: session.frames.map((frame) => {
      const withoutThread = frame.conversationIds.filter((id) => id !== threadId);
      return frame.id === frameId
        ? { ...frame, conversationIds: [...withoutThread, threadId] }
        : { ...frame, conversationIds: withoutThread };
    }),
  };
}

function createFrame(
  session: BenchSessionSnapshot,
  frame: BenchSessionSnapshot['frames'][number],
): BenchSessionSnapshot {
  if (session.frames.some((candidate) => candidate.id === frame.id)) return session;
  const members = new Set(frame.conversationIds);
  return {
    ...session,
    frames: [
      ...session.frames.map((candidate) => ({
        ...candidate,
        conversationIds: candidate.conversationIds.filter((id) => !members.has(id)),
      })),
      { ...frame, conversationIds: [...frame.conversationIds] },
    ],
  };
}

function pruneConversation(
  session: BenchSessionSnapshot,
  threadId: string,
): BenchSessionSnapshot {
  const { [threadId]: _removedScroll, ...remainingScroll } = session.scrollTopByThreadId;
  return {
    ...session,
    openThreadIds: session.openThreadIds.filter((id) => id !== threadId),
    shelvedThreadIds: session.shelvedThreadIds.filter((id) => id !== threadId),
    trails: session.trails.filter((trail) => trail.threadId !== threadId),
    frames: session.frames.map((frame) => ({
      ...frame,
      conversationIds: frame.conversationIds.filter((id) => id !== threadId),
    })),
    scrollTopByThreadId: remainingScroll,
    focusedThreadId: session.focusedThreadId === threadId ? null : session.focusedThreadId,
  };
}

/**
 * Removing from canvas ≠ archive and ≠ kill (Chris ruling 2026-08-21): the card
 * leaves the canvas, everything else about the conversation stays. Scroll
 * memory is kept so re-revealing restores the reading position.
 */
function shelveConversation(
  session: BenchSessionSnapshot,
  threadId: string,
): BenchSessionSnapshot {
  return {
    ...session,
    openThreadIds: session.openThreadIds.filter((id) => id !== threadId),
    shelvedThreadIds: session.shelvedThreadIds.includes(threadId)
      ? session.shelvedThreadIds
      : [...session.shelvedThreadIds, threadId],
    trails: session.trails.filter((trail) => trail.threadId !== threadId),
    frames: session.frames.map((frame) => ({
      ...frame,
      conversationIds: frame.conversationIds.filter((id) => id !== threadId),
    })),
    focusedThreadId: session.focusedThreadId === threadId ? null : session.focusedThreadId,
  };
}

function reconcileSession(
  session: BenchSessionSnapshot,
  action: Extract<BenchAction, { type: 'reconcile-session' }>,
): BenchSessionSnapshot {
  const threadIds = new Set(action.threadIds);
  const scrollTopByThreadId = Object.fromEntries(Object.entries(session.scrollTopByThreadId)
    .filter(([threadId]) => threadIds.has(threadId)));
  return {
    ...session,
    openThreadIds: session.openThreadIds.filter((id) => threadIds.has(id)),
    shelvedThreadIds: session.shelvedThreadIds.filter((id) => threadIds.has(id)),
    trails: reconcileInspectionTrails(
      session.trails.filter((trail) => threadIds.has(trail.threadId)),
      action,
    ),
    frames: session.frames.map((frame) => ({
      ...frame,
      conversationIds: frame.conversationIds.filter((id) => threadIds.has(id)),
    })),
    scrollTopByThreadId,
    focusedThreadId: session.focusedThreadId && threadIds.has(session.focusedThreadId)
      ? session.focusedThreadId
      : null,
  };
}

/** Applies one semantic action without touching canvas or host state. */
export function reduceBenchState(state: BenchState, action: BenchAction): BenchState {
  const session = state.session;
  switch (action.type) {
    case 'open-conversation':
      // Opening always surfaces the card — a shelved conversation un-shelves.
      return {
        ...state,
        session: {
          ...session,
          openThreadIds: session.openThreadIds.includes(action.threadId)
            ? session.openThreadIds
            : [...session.openThreadIds, action.threadId],
          shelvedThreadIds: session.shelvedThreadIds.filter((id) => id !== action.threadId),
        },
      };
    case 'collapse-conversation':
      return {
        ...state,
        session: {
          ...session,
          openThreadIds: session.openThreadIds.filter((id) => id !== action.threadId),
          trails: session.trails.filter((trail) => trail.threadId !== action.threadId),
          focusedThreadId: session.focusedThreadId === action.threadId ? null : session.focusedThreadId,
        },
      };
    case 'inspect-message':
    case 'expand-message-relation':
    case 'expand-relation':
    case 'close-trail-step':
    case 'append-decision':
      return { ...state, session: reduceInspectionTrails(session, action) };
    case 'remember-scroll':
      return {
        ...state,
        session: {
          ...session,
          scrollTopByThreadId: { ...session.scrollTopByThreadId, [action.threadId]: action.scrollTop },
        },
      };
    case 'set-zoom-tier':
      return action.tier === state.zoomTier ? state : { ...state, zoomTier: action.tier };
    case 'focus-conversation':
      // Focus is a reveal — it also returns a shelved card to the canvas.
      return {
        ...state,
        session: {
          ...session,
          focusedThreadId: action.threadId,
          shelvedThreadIds: session.shelvedThreadIds.filter((id) => id !== action.threadId),
        },
      };
    case 'clear-focus':
      return { ...state, session: { ...session, focusedThreadId: null } };
    case 'create-draft':
      return session.pendingDraft
        ? state
        : { ...state, session: { ...session, pendingDraft: { id: action.draftId } } };
    case 'cancel-draft':
      return { ...state, session: { ...session, pendingDraft: null } };
    case 'accept-draft':
      return {
        ...state,
        session: {
          ...session,
          pendingDraft: null,
          openThreadIds: session.openThreadIds.includes(action.threadId)
            ? session.openThreadIds
            : [...session.openThreadIds, action.threadId],
          focusedThreadId: action.threadId,
        },
      };
    case 'create-frame':
      return { ...state, session: createFrame(session, action.frame) };
    case 'rename-frame':
      return {
        ...state,
        session: {
          ...session,
          frames: session.frames.map((frame) => (
            frame.id === action.frameId ? { ...frame, name: action.name } : frame
          )),
        },
      };
    case 'set-frame-membership':
      return { ...state, session: setFrameMembership(session, action.threadId, action.frameId) };
    case 'remove-frame':
      return {
        ...state,
        session: { ...session, frames: session.frames.filter((frame) => frame.id !== action.frameId) },
      };
    case 'clear-trails':
      return { ...state, session: { ...session, trails: [] } };
    case 'shelve-conversation':
      return { ...state, session: shelveConversation(session, action.threadId) };
    case 'unshelve-conversation':
      return {
        ...state,
        session: {
          ...session,
          shelvedThreadIds: session.shelvedThreadIds.filter((id) => id !== action.threadId),
        },
      };
    case 'prune-conversation':
      return { ...state, session: pruneConversation(session, action.threadId) };
    case 'reconcile-session':
      return { ...state, session: reconcileSession(session, action) };
    case 'restore-session':
      return { ...state, session: createInitialBenchState(action.session).session };
  }
}

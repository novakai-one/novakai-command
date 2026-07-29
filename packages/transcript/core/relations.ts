import type {
  TranscriptRelationDelta,
  TranscriptRelationState,
} from '../contract/schemas.js';

export function emptyTranscriptRelationState(): TranscriptRelationState {
  return { parents: {}, children: {} };
}

export function applyTranscriptRelationDelta(
  state: TranscriptRelationState,
  delta: TranscriptRelationDelta,
): TranscriptRelationState {
  if (delta.type === 'parent') {
    if (state.parents[delta.parentKey]) return state;
    return {
      parents: {
        ...state.parents,
        [delta.parentKey]: {
          parentTurnId: delta.parentTurnId,
          remainingChildren: delta.remainingChildren,
          ...(delta.parentAgentId
            ? { parentAgentId: delta.parentAgentId }
            : {}),
        },
      },
      children: state.children,
    };
  }

  if (state.children[delta.childKey]) return state;
  const parent = state.parents[delta.parentKey];
  if (!parent) return state;
  const parents = { ...state.parents };
  if (parent.remainingChildren === 1) {
    delete parents[delta.parentKey];
  } else {
    parents[delta.parentKey] = {
      ...parent,
      remainingChildren: parent.remainingChildren - 1,
    };
  }
  return {
    parents,
    children: {
      ...state.children,
      [delta.childKey]: {
        parentTurnId: parent.parentTurnId,
        ...(delta.agentId ? { agentId: delta.agentId } : {}),
        ...(parent.parentAgentId
          ? { parentAgentId: parent.parentAgentId }
          : {}),
      },
    },
  };
}

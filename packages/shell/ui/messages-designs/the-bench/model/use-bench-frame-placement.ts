import { useCallback, type Dispatch, type MutableRefObject } from 'react';
import type {
  CanvasPlacementChange,
  CanvasPlacementCommand,
  WorldPoint,
} from '../../../canvas/WorldCanvas';
import { resolveBenchFrameDrop } from './bench-layout';
import type {
  BenchAction,
  BenchModel,
  BenchSessionSnapshot,
  BenchState,
} from './bench-model';

export type BenchPlacementRollback = {
  readonly session: BenchSessionSnapshot;
  readonly frameSeedId?: string;
};

type IssueBenchPlacementCommand = (
  mutations: CanvasPlacementCommand['mutations'],
  rollback: BenchPlacementRollback,
) => void;

/** Owns drag-end frame creation and membership without leaking it into the controller. */
export function useBenchFramePlacement(options: {
  readonly stateRef: MutableRefObject<BenchState>;
  readonly modelRef: MutableRefObject<BenchModel>;
  readonly frameSeedPointsRef: MutableRefObject<Map<string, WorldPoint>>;
  readonly dispatch: Dispatch<BenchAction>;
  readonly issuePlacementCommand: IssueBenchPlacementCommand;
  readonly rememberPlacementChange: (change: CanvasPlacementChange) => void;
  readonly nextFrameId: () => string;
}): (change: CanvasPlacementChange) => void {
  const {
    stateRef,
    modelRef,
    frameSeedPointsRef,
    dispatch,
    issuePlacementCommand,
    rememberPlacementChange,
    nextFrameId,
  } = options;
  return useCallback((change: CanvasPlacementChange) => {
    rememberPlacementChange(change);
    if (change.cause !== 'drag-end' || !change.movedNodeId) return;
    const intent = resolveBenchFrameDrop(
      change.movedNodeId,
      change.placements,
      modelRef.current,
      stateRef.current,
    );
    if (intent.type === 'none') return;
    const rollback = { session: stateRef.current.session };

    if (intent.type === 'create') {
      const frameId = nextFrameId();
      frameSeedPointsRef.current.set(frameId, intent.position);
      dispatch({
        type: 'create-frame',
        frame: {
          id: frameId,
          name: 'Untitled frame',
          conversationIds: [intent.threadId, intent.targetThreadId],
        },
      });
      issuePlacementCommand([
        { type: 'set-node-parent', nodeId: intent.threadId, parentId: frameId },
        { type: 'set-node-parent', nodeId: intent.targetThreadId, parentId: frameId },
      ], { ...rollback, frameSeedId: frameId });
      return;
    }

    const parentId = intent.type === 'join' ? intent.frameId : null;
    dispatch({ type: 'set-frame-membership', threadId: intent.threadId, frameId: parentId });
    issuePlacementCommand([{
      type: 'set-node-parent',
      nodeId: intent.threadId,
      parentId,
    }], rollback);
  }, [
    dispatch,
    frameSeedPointsRef,
    issuePlacementCommand,
    modelRef,
    nextFrameId,
    rememberPlacementChange,
    stateRef,
  ]);
}

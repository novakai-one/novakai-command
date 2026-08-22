import { useCallback, type Dispatch, type MutableRefObject } from 'react';
import type {
  CanvasNodePlacement,
  CanvasPlacementCommand,
} from '../../../canvas/WorldCanvas';
import type { MessagesDesignProps } from '../../contract';
import type { BenchAction, BenchConversation, BenchState } from './bench-model';
import type { BenchPlacementRollback } from './use-bench-frame-placement';
import type { RemovedBenchPlacement } from './use-bench-placement-interaction';

type ReversibleRemovalOptions = {
  readonly catalog: readonly BenchConversation[];
  readonly placements: readonly CanvasNodePlacement[] | null;
  readonly selectedId: string | null;
  readonly zenThreadId: string | null;
  readonly stateRef: MutableRefObject<BenchState>;
  readonly commandsRef: MutableRefObject<MessagesDesignProps['commands']>;
  readonly dispatch: Dispatch<BenchAction>;
  readonly exitZen: () => void;
  readonly issuePlacementCommand: (
    mutations: CanvasPlacementCommand['mutations'],
    rollback: BenchPlacementRollback,
  ) => void;
  readonly offerUndo: (removed: RemovedBenchPlacement) => void;
  readonly takeUndo: () => RemovedBenchPlacement | null;
};

/** Coordinates the reversible Placement lifecycle without entering Thread history. */
export function useBenchRemoval(options: ReversibleRemovalOptions) {
  const removeConversationFromBench = useCallback((threadId: string) => {
    const session = options.stateRef.current.session;
    if (!session.placedThreadIds.includes(threadId)) return;
    const rememberedPlacement = options.placements?.find((placement) => placement.id === threadId);
    if (!rememberedPlacement) return;
    const frameId = session.frames.find((frame) => frame.conversationIds.includes(threadId))?.id;
    options.offerUndo({
      threadId,
      title: options.catalog.find((candidate) => candidate.thread.id === threadId)?.thread.title
        ?? 'Conversation',
      point: rememberedPlacement.position,
      ...(rememberedPlacement.parentId ? { parentId: rememberedPlacement.parentId } : {}),
      ...(frameId ? { frameId } : {}),
    });
    if (options.zenThreadId === threadId) options.exitZen();
    if (options.selectedId === threadId) options.commandsRef.current.select(null);
    options.dispatch({ type: 'remove-conversation', threadId });
    options.issuePlacementCommand(
      [{ type: 'remove-node', nodeId: threadId }],
      { session },
    );
  }, [options]);

  const undoRemoval = useCallback(() => {
    const removed = options.takeUndo();
    if (!removed || !options.catalog.some((entry) => entry.thread.id === removed.threadId)) return;
    const session = options.stateRef.current.session;
    const validParentId = removed.frameId
      && removed.parentId === removed.frameId
      && session.frames.some((frame) => frame.id === removed.frameId)
      ? removed.parentId
      : null;
    options.dispatch({ type: 'place-conversation', threadId: removed.threadId });
    if (validParentId && removed.frameId) {
      options.dispatch({ type: 'set-frame-membership', threadId: removed.threadId, frameId: removed.frameId });
    }
    options.issuePlacementCommand([
      { type: 'set-node-position', nodeId: removed.threadId, position: removed.point },
      { type: 'set-node-parent', nodeId: removed.threadId, parentId: validParentId },
    ], { session });
  }, [options]);

  return { removeConversationFromBench, undoRemoval };
}

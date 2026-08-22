import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CanvasPlacementCommand, CanvasPlacementCommandOutcome, WorldPoint } from '../../../canvas/WorldCanvas';
import type { WorldCameraCommand, WorldViewport } from '../../../canvas/world-camera';
import type { ObjectId, ObjectRecord } from '../../contract';
import type { MessagesDesignProps } from '../../contract';
import { buildRevealConversationCommand, buildRevealNodeCommand, interpretBenchKey, type BenchKeyInput } from './bench-interaction';
import type { BenchModel, BenchNodeActions, BenchState } from './bench-model';
import type { BenchController } from './bench-controller';
import { createInitialBenchState, reduceBenchState } from './bench-reducer';
import { readBenchSession, rememberBenchSession } from './bench-session-memory';
import { buildBenchModel, initialBenchPlacementIds, projectBenchConversationCatalog, projectBenchCanvas } from './bench-projection';
import { useBenchFirstFreePoint, useBenchPlacements, useBenchViewportPolicy } from './use-bench-canvas-state';
import { useBenchFramePlacement, type BenchPlacementRollback } from './use-bench-frame-placement';
import { useBenchConversationActions } from './use-bench-conversation-actions';
import { useBenchOffscreenTracking } from './use-bench-offscreen-tracking';
import { useBenchPlacementInteraction } from './use-bench-placement-interaction';
import { useBenchRemoval } from './use-bench-removal';

let benchIdentitySequence = 0;

function nextBenchIdentity(prefix: 'draft' | 'frame' | 'placement'): string {
  benchIdentitySequence += 1;
  return `${prefix}:bench:${Date.now().toString(36)}:${benchIdentitySequence.toString(36)}`;
}

/** Coordinates host commands, semantic state, projection, and neutral canvas callbacks. */
export function useBenchController({ data, commands }: MessagesDesignProps): BenchController {
  const conversationCatalog = useMemo(() => projectBenchConversationCatalog(data), [data]);
  const initialPlacedThreadIds = useMemo(
    () => initialBenchPlacementIds(conversationCatalog),
    [conversationCatalog],
  );
  const [state, dispatch] = useReducer(
    reduceBenchState,
    undefined,
    () => createInitialBenchState(readBenchSession(initialPlacedThreadIds), {
      initialPlacedThreadIds,
      initialThreadId: data.initialThreadId,
    }),
  );
  const [cameraCommand, setCameraCommand] = useState<WorldCameraCommand | null>(null);
  const [placementCommand, setPlacementCommand] = useState<CanvasPlacementCommand | null>(null);
  const [zenThreadId, setZenThreadId] = useState<ObjectId | null>(null);
  const [draftPoint, setDraftPoint] = useState<WorldPoint | null>(null);
  const frameSeedPointsRef = useRef(new Map<string, WorldPoint>());
  const placementRollbackRef = useRef<BenchPlacementRollback | null>(null);
  const preZenViewportRef = useRef<WorldViewport | null>(null);
  const model = useMemo(
    () => buildBenchModel(data, conversationCatalog, state.session.placedThreadIds),
    [conversationCatalog, data, state.session.placedThreadIds],
  );
  const stateRef = useRef(state);
  const modelRef = useRef(model);
  const commandsRef = useRef(commands);
  stateRef.current = state;
  modelRef.current = model;
  commandsRef.current = commands;
  const { placementChange, rememberPlacementChange } = useBenchPlacements();
  const placements = placementChange?.placements ?? null;
  const { viewportRef, onViewportChange, onZoomChange } = useBenchViewportPolicy(dispatch);
  const firstFreeVisiblePoint = useBenchFirstFreePoint(placements, viewportRef);
  const {
    pendingPlacement,
    removalUndo,
    beginPlacement,
    movePlacement,
    takePlacement,
    cancelPlacement,
    offerRemovalUndo,
    takeRemovalUndo,
    dismissRemovalUndo,
  } = useBenchPlacementInteraction(conversationCatalog, firstFreeVisiblePoint);

  const exitZen = useCallback(() => {
    if (!zenThreadId) return;
    setZenThreadId(null);
    const viewport = preZenViewportRef.current;
    if (viewport) {
      setCameraCommand({
        type: 'set-viewport',
        key: `bench:leave-zen:${Date.now()}`,
        viewport: { ...viewport },
        duration: 0,
      });
    }
    preZenViewportRef.current = null;
  }, [zenThreadId]);

  const issuePlacementCommand = useCallback((
    mutations: CanvasPlacementCommand['mutations'],
    rollback: BenchPlacementRollback,
  ) => {
    placementRollbackRef.current = rollback;
    setPlacementCommand({
      type: 'apply-placement-mutations',
      key: nextBenchIdentity('placement'),
      mutations,
    });
  }, []);
  const nextFrameId = useCallback(() => nextBenchIdentity('frame'), []);

  const onPlacementChange = useBenchFramePlacement({
    stateRef,
    modelRef,
    frameSeedPointsRef,
    dispatch,
    issuePlacementCommand,
    rememberPlacementChange,
    nextFrameId,
  });

  const locateConversation = useCallback((threadId: ObjectId) => {
    if (!stateRef.current.session.placedThreadIds.includes(threadId)) return;
    cancelPlacement();
    commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    setCameraCommand(buildRevealConversationCommand(threadId));
  }, [cancelPlacement]);

  const commitPendingPlacement = useCallback((pointer: WorldPoint) => {
    const placement = takePlacement(pointer);
    if (!placement) return;
    const threadId = placement.threadId;
    if (stateRef.current.session.placedThreadIds.includes(threadId)) return;
    const rollback = { session: stateRef.current.session };
    dispatch({ type: 'place-conversation', threadId });
    commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    issuePlacementCommand([{
      type: 'set-node-position',
      nodeId: threadId,
      position: placement.point,
    }], rollback);
  }, [issuePlacementCommand, takePlacement]);

  const { removeConversationFromBench, undoRemoval } = useBenchRemoval({
    catalog: conversationCatalog,
    placements,
    selectedId: data.selected?.id ?? null,
    zenThreadId,
    stateRef,
    commandsRef,
    dispatch,
    exitZen,
    issuePlacementCommand,
    offerUndo: offerRemovalUndo,
    takeUndo: takeRemovalUndo,
  });

  const { actOnConversation } = useBenchConversationActions({
    stateRef,
    modelRef,
    commandsRef,
    locateConversation,
    beginPlacement,
    removeConversation: removeConversationFromBench,
  });
  const removableThreadIds = useMemo(() => {
    if (!placements) return [];
    const placedIds = new Set(state.session.placedThreadIds);
    return placements.flatMap((placement) => placedIds.has(placement.id) ? [placement.id] : []);
  }, [placements, state.session.placedThreadIds]);

  const removeFrame = useCallback((frameId: string) => {
    const frame = stateRef.current.session.frames.find((candidate) => candidate.id === frameId);
    if (!frame) return;
    const rollback = { session: stateRef.current.session };
    dispatch({ type: 'remove-frame', frameId });
    issuePlacementCommand(
      [
        ...frame.conversationIds.map((nodeId) => ({
          type: 'set-node-parent' as const,
          nodeId,
          parentId: null,
        })),
        { type: 'remove-node' as const, nodeId: frameId },
      ],
      rollback,
    );
  }, [issuePlacementCommand]);

  const nodeActions = useMemo<BenchNodeActions>(() => ({
    openConversation: (threadId) => {
      dispatch({ type: 'open-conversation', threadId });
      commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    },
    collapseConversation: (threadId) => dispatch({ type: 'collapse-conversation', threadId }),
    removeConversationFromBench,
    inspectMessage: (threadId, messageId) => {
      dispatch({ type: 'inspect-message', threadId, messageId });
      commandsRef.current.select(modelRef.current.recordsById.get(messageId) ?? null);
    },
    expandMessageRelation: (threadId, messageId, relation, recordId) => {
      dispatch({
        type: 'expand-message-relation',
        threadId,
        messageId,
        relation,
        recordId,
      });
      commandsRef.current.select(modelRef.current.recordsById.get(recordId) ?? null);
    },
    expandRelation: (trailId, parentStepId, relation, recordId) => {
      dispatch({ type: 'expand-relation', trailId, parentStepId, relation, recordId });
      commandsRef.current.select(modelRef.current.recordsById.get(recordId) ?? null);
    },
    closeTrailStep: (trailId, stepId) => dispatch({ type: 'close-trail-step', trailId, stepId }),
    answerDecisionRequest: (context, ruling) => {
      const trimmedRuling = ruling.trim();
      if (!trimmedRuling) return;
      const decisionId = commandsRef.current.answerDecisionRequest({
        requestId: context.requestId,
        ruling: trimmedRuling,
      });
      dispatch({ type: 'append-decision', context, decisionId });
      commandsRef.current.select(modelRef.current.recordsById.get(context.requestId) ?? null);
    },
    selectRecord: (recordId) => commandsRef.current.select(
      recordId ? modelRef.current.recordsById.get(recordId) ?? null : null,
    ),
    canTravel: (recordId) => {
      const record = modelRef.current.recordsById.get(recordId);
      return record ? commandsRef.current.canOpen(record) : false;
    },
    travel: (recordId) => {
      const record = modelRef.current.recordsById.get(recordId);
      if (record && commandsRef.current.canOpen(record)) commandsRef.current.open(record);
    },
    sendMessage: (threadId, body) => {
      const trimmedBody = body.trim();
      if (trimmedBody) commandsRef.current.send(threadId, trimmedBody);
    },
    rememberTranscriptScroll: (threadId, scrollTop) => {
      dispatch({ type: 'remember-scroll', threadId, scrollTop });
    },
    markThreadRead: (threadId) => commandsRef.current.markThreadRead(threadId),
    // D34: hosts without a resend route simply render no affordance.
    resendMessage: (threadId, messageId) => commandsRef.current.resendMessage?.(threadId, messageId),
    attachThreadToMission: (threadId, missionId) => (
      commandsRef.current.attachThreadToMission(threadId, missionId)
    ),
    archiveConversation: (threadId) => {
      commandsRef.current.archiveThread(threadId);
      removeConversationFromBench(threadId);
    },
    renameFrame: (frameId, name) => dispatch({ type: 'rename-frame', frameId, name }),
    removeFrame,
  }), [removeConversationFromBench, removeFrame]);

  const acceptDraft = useCallback((agent: ObjectRecord) => {
    const draft = stateRef.current.session.pendingDraft;
    if (!draft) return;
    const rollback = { session: stateRef.current.session };
    const threadId = commandsRef.current.startConversation(agent);
    dispatch({ type: 'accept-draft', threadId });
    setDraftPoint(null);
    issuePlacementCommand([{
      type: 'replace-node-identity',
      fromNodeId: draft.id,
      toNodeId: threadId,
    }], rollback);
  }, [issuePlacementCommand]);

  const cancelDraft = useCallback(() => {
    dispatch({ type: 'cancel-draft' });
    setDraftPoint(null);
  }, []);

  const projection = useMemo(
    () => projectBenchCanvas(model, state, placements, nodeActions, {
      draftPoint,
      frameSeedPoints: frameSeedPointsRef.current,
      acceptDraft,
      cancelDraft,
    }),
    [acceptDraft, cancelDraft, draftPoint, model, nodeActions, placements, state],
  );
  const { offscreenCandidates, acknowledgeOffscreenNodes } = useBenchOffscreenTracking(
    projection,
    placementChange?.cause ?? null,
  );

  useEffect(() => {
    rememberBenchSession(state.session);
  }, [state.session]);

  useEffect(() => {
    dispatch({
      type: 'reconcile-session',
      threadIds: conversationCatalog.map((conversation) => conversation.thread.id),
      messageIds: conversationCatalog.flatMap((conversation) => (
        conversation.messages.map((message) => message.record.id)
      )),
      recordIds: data.graph.all.map((record) => record.id),
    });
  }, [conversationCatalog, data.graph]);

  const onPlacementCommandOutcome = useCallback((outcome: CanvasPlacementCommandOutcome) => {
    if (outcome.status === 'rejected' && placementRollbackRef.current) {
      dispatch({ type: 'restore-session', session: placementRollbackRef.current.session });
      dismissRemovalUndo();
      if (placementRollbackRef.current.frameSeedId) {
        frameSeedPointsRef.current.delete(placementRollbackRef.current.frameSeedId);
      }
    }
    placementRollbackRef.current = null;
    setPlacementCommand(null);
  }, [dismissRemovalUndo]);

  const locateOffscreenNode = useCallback((nodeId: string) => {
    setCameraCommand(buildRevealNodeCommand(nodeId));
  }, []);

  const createDraftAt = useCallback((requested?: WorldPoint) => {
    const existing = stateRef.current.session.pendingDraft;
    if (existing) {
      setCameraCommand(buildRevealNodeCommand(existing.id));
      return;
    }
    const draftId = nextBenchIdentity('draft');
    setDraftPoint(firstFreeVisiblePoint(requested));
    dispatch({ type: 'create-draft', draftId });
  }, [firstFreeVisiblePoint]);

  const onKeyInput = useCallback((input: Omit<BenchKeyInput, 'currentZoom'>) => {
    if (input.key === 'Escape') {
      if (pendingPlacement) {
        cancelPlacement();
        return;
      }
      if (zenThreadId) exitZen();
      return;
    }
    if (input.key.toLocaleLowerCase() === 'f') {
      if (!input.activeThreadId || !modelRef.current.conversationsById.has(input.activeThreadId)) return;
      preZenViewportRef.current = { ...viewportRef.current };
      dispatch({ type: 'focus-conversation', threadId: input.activeThreadId });
      setZenThreadId(input.activeThreadId);
      return;
    }
    const result = interpretBenchKey({ ...input, currentZoom: viewportRef.current.zoom });
    if (result.action) dispatch(result.action);
    if (result.cameraCommand) setCameraCommand(result.cameraCommand);
  }, [cancelPlacement, exitZen, pendingPlacement, viewportRef, zenThreadId]);

  const onCanvasSelect = useCallback((recordId: string | null) => {
    nodeActions.selectRecord(recordId);
  }, [nodeActions]);

  return {
    state,
    model,
    conversationCatalog,
    removableThreadIds,
    projection,
    selectedId: data.selected?.id ?? null,
    cameraCommand,
    placementCommand,
    pendingPlacement,
    removalUndo,
    actions: nodeActions,
    zenThreadId,
    zenConversation: zenThreadId ? model.conversationsById.get(zenThreadId) ?? null : null,
    offscreenCandidates,
    onCanvasSelect,
    onPlacementChange,
    onPlacementCommandOutcome,
    onViewportChange,
    onZoomChange,
    onPaneDoubleClick: (position) => {
      if (!pendingPlacement) createDraftAt(position);
    },
    onPaneClick: commitPendingPlacement,
    onPanePointerMove: movePlacement,
    onKeyInput,
    createDraft: () => createDraftAt(),
    clearTrails: () => dispatch({ type: 'clear-trails' }),
    actOnConversation,
    cancelPlacement,
    undoRemoval,
    dismissRemovalUndo,
    locateOffscreenNode,
    acknowledgeOffscreenNodes,
    exitZen,
  };
}

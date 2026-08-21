import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  CanvasPlacementChange,
  CanvasPlacementCommand,
  CanvasPlacementCommandOutcome,
  WorldPoint,
} from '../../../canvas/WorldCanvas';
import { readRememberedNodeSize, rememberNodeSize } from '../../../canvas/canvas-size-memory';
import type { WorldCameraCommand, WorldViewport } from '../../../canvas/world-camera';
import type { ObjectId, ObjectRecord } from '../../contract';
import type { MessagesDesignProps } from '../../contract';
import {
  buildRevealConversationCommand,
  buildRevealNodeCommand,
  interpretBenchKey,
  type BenchKeyInput,
} from './bench-interaction';
import { firstFreePoint, resolveBenchFrameDrop } from './bench-layout';
import {
  BENCH_VIEWPORT_KEY,
  type BenchConversation,
  type BenchModel,
  type BenchNodeActions,
  type BenchOffscreenCandidate,
  type BenchSessionSnapshot,
  type BenchState,
} from './bench-model';
import {
  nextBenchIdentity,
  useBenchPlacements,
  useBenchViewportPolicy,
} from './bench-controller-support';
import { createBenchNodeActions } from './bench-node-actions';
import { useOffscreenCandidates } from './useOffscreenCandidates';
import { createInitialBenchState, reduceBenchState } from './bench-reducer';
import { readBenchSession, rememberBenchSession } from './bench-session-memory';
import {
  buildBenchModel,
  projectBenchCanvas,
  type BenchCanvasProjection,
} from './bench-projection';

type PlacementRollback = {
  readonly session: BenchSessionSnapshot;
  readonly frameSeedId?: string;
};

/** Complete view-facing contract returned by the Bench orchestrator. */
export type BenchController = {
  readonly state: BenchState;
  readonly model: BenchModel;
  readonly projection: BenchCanvasProjection;
  readonly selectedId: ObjectId | null;
  readonly cameraCommand: WorldCameraCommand | null;
  readonly placementCommand: CanvasPlacementCommand | null;
  readonly actions: BenchNodeActions;
  readonly zenThreadId: ObjectId | null;
  readonly zenConversation: BenchConversation | null;
  readonly offscreenCandidates: readonly BenchOffscreenCandidate[];
  readonly onCanvasSelect: (recordId: string | null) => void;
  readonly onPlacementChange: (change: CanvasPlacementChange) => void;
  readonly onPlacementCommandOutcome: (outcome: CanvasPlacementCommandOutcome) => void;
  readonly onViewportChange: (viewport: WorldViewport) => void;
  readonly onZoomChange: (zoom: number) => void;
  readonly onPaneDoubleClick: (position: WorldPoint) => void;
  readonly onKeyInput: (input: Omit<BenchKeyInput, 'currentZoom'>) => void;
  readonly createDraft: () => void;
  readonly clearTrails: () => void;
  readonly revealConversation: (threadId: ObjectId) => void;
  readonly revealOffscreenNode: (nodeId: string) => void;
  readonly acknowledgeOffscreenNodes: (nodeIds: readonly string[]) => void;
  readonly exitZen: () => void;
};

/** Coordinates host commands, semantic state, projection, and neutral canvas callbacks. */
export function useBenchController({ data, commands }: MessagesDesignProps): BenchController {
  const [state, dispatch] = useReducer(
    reduceBenchState,
    undefined,
    () => createInitialBenchState(readBenchSession(), data.initialThreadId),
  );
  const [cameraCommand, setCameraCommand] = useState<WorldCameraCommand | null>(null);
  const [placementCommand, setPlacementCommand] = useState<CanvasPlacementCommand | null>(null);
  const [zenThreadId, setZenThreadId] = useState<ObjectId | null>(null);
  const [draftPoint, setDraftPoint] = useState<WorldPoint | null>(null);
  // Bumped when a resize settles so the projection re-applies the stored size
  // in the same beat instead of waiting for the next unrelated state change.
  const [sizesRevision, setSizesRevision] = useState(0);
  const frameSeedPointsRef = useRef(new Map<string, WorldPoint>());
  const placementRollbackRef = useRef<PlacementRollback | null>(null);
  const preZenViewportRef = useRef<WorldViewport | null>(null);
  const model = useMemo(() => buildBenchModel(data), [data]);
  const stateRef = useRef(state);
  const modelRef = useRef(model);
  const commandsRef = useRef(commands);
  stateRef.current = state;
  modelRef.current = model;
  commandsRef.current = commands;
  const { placementChange, rememberPlacementChange } = useBenchPlacements();
  const placements = placementChange?.placements ?? null;
  const { viewportRef, onViewportChange, onZoomChange } = useBenchViewportPolicy(dispatch);

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
    rollback: PlacementRollback,
  ) => {
    placementRollbackRef.current = rollback;
    setPlacementCommand({
      type: 'apply-placement-mutations',
      key: nextBenchIdentity('placement'),
      mutations,
    });
  }, []);

  const removeFrame = useCallback((frameId: string) => {
    const frame = stateRef.current.session.frames.find((candidate) => candidate.id === frameId);
    if (!frame) return;
    const rollback = { session: stateRef.current.session };
    dispatch({ type: 'remove-frame', frameId });
    if (frame.conversationIds.length === 0) return;
    issuePlacementCommand(
      frame.conversationIds.map((nodeId) => ({
        type: 'set-node-parent' as const,
        nodeId,
        parentId: null,
      })),
      rollback,
    );
  }, [issuePlacementCommand]);

  const rememberSize = useCallback((nodeId: string, size: { width: number; height: number }) => {
    rememberNodeSize(BENCH_VIEWPORT_KEY, nodeId, size);
    setSizesRevision((revision) => revision + 1);
  }, []);

  const nodeActions = useMemo<BenchNodeActions>(() => createBenchNodeActions({
    dispatch, commandsRef, modelRef, zenThreadId, exitZen, removeFrame, rememberSize,
  }), [exitZen, rememberSize, removeFrame, zenThreadId]);

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
      sizeOf: (nodeId) => readRememberedNodeSize(BENCH_VIEWPORT_KEY, nodeId),
    }),
    // sizesRevision: stored sizes are read inside sizeOf — a settled resize
    // must re-project even though no other input changed.
    [acceptDraft, cancelDraft, draftPoint, model, nodeActions, placements, state, sizesRevision],
  );

  useEffect(() => {
    rememberBenchSession(state.session);
  }, [state.session]);

  useEffect(() => {
    dispatch({
      type: 'reconcile-session',
      threadIds: model.conversations.map((conversation) => conversation.thread.id),
      messageIds: [...model.messagesById.keys()],
      recordIds: [...model.recordsById.keys()],
    });
  }, [model]);

  const { offscreenCandidates, acknowledgeOffscreenNodes } = useOffscreenCandidates(
    projection,
    placementChange?.cause,
  );

  const handleFramePlacement = useCallback((change: CanvasPlacementChange) => {
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
      const frameId = nextBenchIdentity('frame');
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
  }, [issuePlacementCommand]);

  const onPlacementChange = useCallback((change: CanvasPlacementChange) => {
    rememberPlacementChange(change);
    handleFramePlacement(change);
  }, [handleFramePlacement, rememberPlacementChange]);

  const onPlacementCommandOutcome = useCallback((outcome: CanvasPlacementCommandOutcome) => {
    if (outcome.status === 'rejected' && placementRollbackRef.current) {
      dispatch({ type: 'restore-session', session: placementRollbackRef.current.session });
      if (placementRollbackRef.current.frameSeedId) {
        frameSeedPointsRef.current.delete(placementRollbackRef.current.frameSeedId);
      }
    }
    placementRollbackRef.current = null;
    setPlacementCommand(null);
  }, []);

  const revealConversation = useCallback((threadId: ObjectId) => {
    dispatch({ type: 'focus-conversation', threadId });
    commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    setCameraCommand(buildRevealConversationCommand(threadId));
  }, []);

  const revealOffscreenNode = useCallback((nodeId: string) => {
    setCameraCommand(buildRevealNodeCommand(nodeId));
  }, []);

  const requestedDraftPoint = useCallback((requested?: WorldPoint): WorldPoint => {
    const viewport = viewportRef.current;
    const canvasWidth = typeof window === 'undefined' ? 1200 : Math.max(640, window.innerWidth - 324);
    const canvasHeight = typeof window === 'undefined' ? 760 : Math.max(480, window.innerHeight - 213);
    const point = requested ?? {
      x: (canvasWidth * 0.5 - viewport.x) / viewport.zoom,
      y: (canvasHeight * 0.42 - viewport.y) / viewport.zoom,
    };
    const visibleBounds = requested ? undefined : {
      minX: (-viewport.x / viewport.zoom) + 24,
      maxX: ((canvasWidth - viewport.x) / viewport.zoom) - 344,
      minY: (-viewport.y / viewport.zoom) + 24,
      maxY: ((canvasHeight - viewport.y) / viewport.zoom) - 344,
    };
    return firstFreePoint(
      point,
      (placements ?? []).map((placement) => placement.position),
      visibleBounds,
    );
  }, [placements, viewportRef]);

  const createDraftAt = useCallback((requested?: WorldPoint) => {
    const existing = stateRef.current.session.pendingDraft;
    if (existing) {
      setCameraCommand(buildRevealNodeCommand(existing.id));
      return;
    }
    const draftId = nextBenchIdentity('draft');
    setDraftPoint(requestedDraftPoint(requested));
    dispatch({ type: 'create-draft', draftId });
  }, [requestedDraftPoint]);

  const onKeyInput = useCallback((input: Omit<BenchKeyInput, 'currentZoom'>) => {
    if (input.key === 'Escape') {
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
  }, [exitZen, viewportRef, zenThreadId]);

  const onCanvasSelect = useCallback((recordId: string | null) => {
    nodeActions.selectRecord(recordId);
  }, [nodeActions]);

  return {
    state,
    model,
    projection,
    selectedId: data.selected?.id ?? null,
    cameraCommand,
    placementCommand,
    actions: nodeActions,
    zenThreadId,
    zenConversation: zenThreadId ? model.conversationsById.get(zenThreadId) ?? null : null,
    offscreenCandidates,
    onCanvasSelect,
    onPlacementChange,
    onPlacementCommandOutcome,
    onViewportChange,
    onZoomChange,
    onPaneDoubleClick: (position) => createDraftAt(position),
    onKeyInput,
    createDraft: () => createDraftAt(),
    clearTrails: () => dispatch({ type: 'clear-trails' }),
    revealConversation,
    revealOffscreenNode,
    acknowledgeOffscreenNodes,
    exitZen,
  };
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from 'react';
import type {
  CanvasNodePlacement,
  CanvasPlacementChange,
  CanvasPlacementCommand,
  CanvasPlacementCommandOutcome,
  WorldPoint,
} from '../../../canvas/WorldCanvas';
import type { WorldCameraCommand, WorldViewport } from '../../../canvas/world-camera';
import type { ObjectId, ObjectRecord } from '../../contract';
import type { MessagesDesignProps } from '../../contract';
import {
  buildRevealConversationCommand,
  buildRevealNodeCommand,
  interpretBenchKey,
  resolveBenchZoomTier,
  type BenchKeyInput,
} from './bench-interaction';
import { firstFreePoint, resolveBenchFrameDrop } from './bench-layout';
import type {
  BenchAction,
  BenchConversation,
  BenchModel,
  BenchNodeActions,
  BenchOffscreenCandidate,
  BenchSessionSnapshot,
  BenchState,
} from './bench-model';
import { createInitialBenchState, reduceBenchState } from './bench-reducer';
import { readBenchSession, rememberBenchSession } from './bench-session-memory';
import {
  buildBenchModel,
  projectBenchCanvas,
  type BenchCanvasProjection,
} from './bench-projection';

type SearchResult = {
  readonly conversation: BenchConversation;
  readonly matchedBy: 'conversation' | 'agent' | 'mission' | 'message';
};

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
  readonly isSearchOpen: boolean;
  readonly searchQuery: string;
  readonly searchResults: readonly SearchResult[];
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
  readonly openSearch: () => void;
  readonly closeSearch: () => void;
  readonly setSearchQuery: (query: string) => void;
  readonly exitZen: () => void;
};

let benchIdentitySequence = 0;

function nextBenchIdentity(prefix: 'draft' | 'frame' | 'placement'): string {
  benchIdentitySequence += 1;
  return `${prefix}:bench:${Date.now().toString(36)}:${benchIdentitySequence.toString(36)}`;
}

function placementSignature(placements: readonly CanvasNodePlacement[]): string {
  return placements
    .map((placement) => `${placement.id}:${placement.position.x}:${placement.position.y}:${placement.parentId ?? ''}`)
    .sort()
    .join('|');
}

function useBenchPlacements(): {
  readonly placementChange: CanvasPlacementChange | null;
  readonly rememberPlacementChange: (change: CanvasPlacementChange) => void;
} {
  const [placementChange, setPlacementChange] = useState<CanvasPlacementChange | null>(null);
  const placementSignatureRef = useRef<string | null>(null);
  const rememberPlacementChange = useCallback((change: CanvasPlacementChange) => {
    const signature = `${change.cause}:${change.movedNodeId ?? ''}:${placementSignature(change.placements)}`;
    if (signature === placementSignatureRef.current) return;
    placementSignatureRef.current = signature;
    setPlacementChange({
      ...change,
      placements: change.placements.map((placement) => ({
        ...placement,
        position: { ...placement.position },
      })),
    });
  }, []);

  return { placementChange, rememberPlacementChange };
}

function useBenchViewportPolicy(dispatch: Dispatch<BenchAction>) {
  const viewportRef = useRef<WorldViewport>({ x: 0, y: 0, zoom: 0.82 });
  const onViewportChange = useCallback((viewport: WorldViewport) => {
    viewportRef.current = { ...viewport };
  }, []);
  const onZoomChange = useCallback((zoom: number) => {
    dispatch({ type: 'set-zoom-tier', tier: resolveBenchZoomTier(zoom) });
  }, [dispatch]);
  return { viewportRef, onViewportChange, onZoomChange };
}

function searchBench(model: BenchModel, query: string): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return model.conversations.map((conversation) => ({
    conversation,
    matchedBy: 'conversation' as const,
  }));

  return model.conversations.flatMap<SearchResult>((conversation) => {
    if (`${conversation.thread.title} ${conversation.thread.id}`.toLocaleLowerCase().includes(normalized)) {
      return [{ conversation, matchedBy: 'conversation' as const }];
    }
    if (conversation.participants.some((participant) => (
      participant.record.title.toLocaleLowerCase().includes(normalized)
    ))) return [{ conversation, matchedBy: 'agent' as const }];
    if (conversation.mission?.record.title.toLocaleLowerCase().includes(normalized)) {
      return [{ conversation, matchedBy: 'mission' as const }];
    }
    if (conversation.messages.some((message) => message.body.toLocaleLowerCase().includes(normalized))) {
      return [{ conversation, matchedBy: 'message' as const }];
    }
    return [];
  });
}

type EligibleNode = {
  readonly kind: BenchOffscreenCandidate['kind'];
  readonly isOpen: boolean;
};

function eligibleNodes(projection: BenchCanvasProjection): Map<string, EligibleNode> {
  const eligible = new Map<string, EligibleNode>();
  for (const node of projection.nodes) {
    if (node.data.kind === 'conversation') {
      eligible.set(node.id, { kind: 'conversation', isOpen: node.data.isOpen });
    } else if (node.data.kind === 'message-inspector') {
      eligible.set(node.id, { kind: 'message-inspector', isOpen: true });
    } else if (node.data.kind === 'related-object') {
      eligible.set(node.id, { kind: 'related-object', isOpen: true });
    }
  }
  return eligible;
}

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
  const [isSearchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [draftPoint, setDraftPoint] = useState<WorldPoint | null>(null);
  const [offscreenCandidates, setOffscreenCandidates] = useState<readonly BenchOffscreenCandidate[]>([]);
  const frameSeedPointsRef = useRef(new Map<string, WorldPoint>());
  const placementRollbackRef = useRef<PlacementRollback | null>(null);
  const preZenViewportRef = useRef<WorldViewport | null>(null);
  const offscreenSequenceRef = useRef(0);
  const offscreenReadyRef = useRef(false);
  const previousEligibleNodesRef = useRef(new Map<string, EligibleNode>());
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

  const nodeActions = useMemo<BenchNodeActions>(() => ({
    openConversation: (threadId) => {
      dispatch({ type: 'open-conversation', threadId });
      commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    },
    collapseConversation: (threadId) => dispatch({ type: 'collapse-conversation', threadId }),
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
      if (zenThreadId === threadId) {
        exitZen();
        commandsRef.current.select(null);
      }
      commandsRef.current.archiveThread(threadId);
      dispatch({ type: 'prune-conversation', threadId });
    },
    renameFrame: (frameId, name) => dispatch({ type: 'rename-frame', frameId, name }),
    removeFrame,
  }), [exitZen, removeFrame, zenThreadId]);

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

  useLayoutEffect(() => {
    const current = eligibleNodes(projection);
    if (!offscreenReadyRef.current) {
      if (placementChange?.cause !== 'restore') return;
      previousEligibleNodesRef.current = current;
      offscreenReadyRef.current = true;
      return;
    }

    const previous = previousEligibleNodesRef.current;
    const opened: BenchOffscreenCandidate[] = [];
    for (const [nodeId, node] of current) {
      const prior = previous.get(nodeId);
      const newlyOpened = !prior || (node.kind === 'conversation' && node.isOpen && !prior.isOpen);
      if (!newlyOpened) continue;
      offscreenSequenceRef.current += 1;
      opened.push({ nodeId, kind: node.kind, openedSequence: offscreenSequenceRef.current });
    }
    previousEligibleNodesRef.current = current;
    setOffscreenCandidates((candidates) => {
      const next = candidates
        .filter((candidate) => current.has(candidate.nodeId))
        .filter((candidate) => !opened.some((item) => item.nodeId === candidate.nodeId));
      return opened.length > 0 || next.length !== candidates.length ? [...next, ...opened] : candidates;
    });
  }, [placementChange?.cause, projection]);

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
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  const revealOffscreenNode = useCallback((nodeId: string) => {
    setCameraCommand(buildRevealNodeCommand(nodeId));
  }, []);

  const acknowledgeOffscreenNodes = useCallback((nodeIds: readonly string[]) => {
    if (nodeIds.length === 0) return;
    const acknowledged = new Set(nodeIds);
    setOffscreenCandidates((candidates) => candidates.filter((candidate) => (
      !acknowledged.has(candidate.nodeId)
    )));
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
    if ((input.metaKey || input.ctrlKey) && input.key.toLocaleLowerCase() === 'k') {
      setSearchOpen(true);
      return;
    }
    if (input.key === 'Escape') {
      if (zenThreadId) exitZen();
      else {
        setSearchOpen(false);
        setSearchQuery('');
      }
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
    isSearchOpen,
    searchQuery,
    searchResults: searchBench(model, searchQuery),
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
    openSearch: () => setSearchOpen(true),
    closeSearch: () => {
      setSearchOpen(false);
      setSearchQuery('');
    },
    setSearchQuery,
    exitZen,
  };
}

import { type EdgeTypes, type NodeTypes } from '@xyflow/react';
import { useMemo, useRef, type KeyboardEvent } from 'react';
import './styles/tokens.css';
import './styles/canvas.css';
import './styles/primitives.css';
import { WorldCanvas } from '../../canvas/WorldCanvas';
import type { WorldCanvasInteraction } from '../../canvas/canvas-interaction';
import type { MessagesDesignProps } from '../contract';
import { adaptBenchInstrumentSource } from './conversation-instrument/bench-instrument-source';
import { ConversationInstrument } from './conversation-instrument/ConversationInstrument';
import type { ConversationInstrumentAction } from './conversation-instrument/contract';
import { BENCH_VIEWPORT_KEY } from './model/bench-viewport';
import { useBenchController } from './model/useBenchController';
import { ConversationNode } from './nodes/ConversationNode';
import { ConversationFrameNode } from './nodes/ConversationFrameNode';
import { DraftConversationNode } from './nodes/DraftConversationNode';
import { InspectionWire } from './nodes/InspectionWire';
import { MessageInspectorNode } from './nodes/MessageInspectorNode';
import { RelatedObjectNode } from './nodes/RelatedObjectNode';
import { OffscreenNodeMarker } from './overlays/OffscreenNodeMarker';
import {
  ConversationPlacementGhost,
  PlacementModeNotice,
  PlacementUndoNotice,
} from './overlays/PlacementFeedback';
import { ZenLayer } from './overlays/ZenLayer';
import './styles/bench-state.css';

const benchNodeTypes = {
  'bench-conversation': ConversationNode,
  'bench-conversation-frame': ConversationFrameNode,
  'bench-draft-conversation': DraftConversationNode,
  'bench-message-inspector': MessageInspectorNode,
  'bench-related-object': RelatedObjectNode,
} satisfies NodeTypes;

const benchEdgeTypes = {
  'bench-inspection': InspectionWire,
} satisfies EdgeTypes;

const BENCH_INTERACTION: WorldCanvasInteraction = {
  nodesDraggable: true,
  nodeDragAxis: 'both',
  elementsSelectable: true,
  selectionOnDrag: false,
  panOnDrag: true,
  panOnScroll: true,
  panOnScrollDirection: 'free',
  zoomOnScroll: false,
  zoomOnPinch: true,
  zoomOnDoubleClick: false,
  minZoom: 0.24,
  maxZoom: 1.5,
  rememberNodePositions: true,
  rememberViewport: true,
};

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.matches('input, textarea, select, [contenteditable="true"]');
}

/** Composes the Bench controller with shared canvas contracts and no private mechanics. */
export function TheBench(props: MessagesDesignProps) {
  const benchRef = useRef<HTMLDivElement>(null);
  const controller = useBenchController(props);
  const instrumentSources = useMemo(
    () => adaptBenchInstrumentSource(
      controller.conversationCatalog,
      controller.state.session.placedThreadIds,
      controller.model.relationsByRecordId,
      controller.removableThreadIds,
    ),
    [
      controller.conversationCatalog,
      controller.model.relationsByRecordId,
      controller.removableThreadIds,
      controller.state.session.placedThreadIds,
    ],
  );
  const selectedThreadId = props.data.selected?.kind === 'thread' ? props.data.selected.id : null;
  const activeThreadId = props.data.selected?.kind === 'thread'
    ? props.data.selected.id
    : [...controller.state.session.openThreadIds]
      .reverse()
      .find((threadId) => controller.model.conversationsById.has(threadId)) ?? null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTextInput(event.target)) return;
    if (!['f', 'F', '[', ']', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    controller.onKeyInput({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      activeThreadId,
    });
  };

  const handleInstrumentAction = (action: ConversationInstrumentAction) => {
    controller.actOnConversation(action);
    if (action.kind === 'locate' || action.kind === 'begin-placement') {
      benchRef.current?.focus({ preventScroll: true });
    }
  };

  const handleCanvasSelect = (recordId: string | null) => {
    controller.onCanvasSelect(recordId);
  };

  return (
    <div
      ref={benchRef}
      className="the-bench"
      data-bench-theme="night-instrument"
      data-zen-thread={controller.zenThreadId ?? 'none'}
      data-placement-mode={controller.pendingPlacement ? 'active' : 'idle'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="The Bench conversation canvas"
    >
      <WorldCanvas
        viewportKey={BENCH_VIEWPORT_KEY}
        nodes={controller.projection.nodes}
        edges={controller.projection.edges}
        nodeTypes={benchNodeTypes}
        edgeTypes={benchEdgeTypes}
        selectedId={controller.selectedId}
        onSelect={handleCanvasSelect}
        resolveSelectionId={(node) => node.data.selectionId}
        onZoomChange={controller.onZoomChange}
        onViewportChange={controller.onViewportChange}
        dragGrid={{ xStep: 8, yStep: 8 }}
        onPaneClick={controller.onPaneClick}
        onPanePointerMove={controller.onPanePointerMove}
        onPaneDoubleClick={controller.onPaneDoubleClick}
        onPlacementChange={controller.onPlacementChange}
        placementCommand={controller.placementCommand}
        onPlacementCommandOutcome={controller.onPlacementCommandOutcome}
        cameraCommand={controller.cameraCommand}
        interaction={BENCH_INTERACTION}
        initialViewport={{ x: 36, y: 40, zoom: 0.82 }}
        fitViewOnMount={false}
        showControls={false}
        surfaceClassName="the-bench__canvas"
        canvasChildren={(
          <>
            <div className="the-bench__field" aria-hidden="true" />
            {controller.pendingPlacement && (
              <ConversationPlacementGhost placement={controller.pendingPlacement} />
            )}
          </>
        )}
        screenChildren={(
          <>
            <div className="the-bench__scale" aria-hidden="true">
              <span>Bench scale</span>
              <strong>{controller.state.zoomTier}</strong>
              <small><kbd>[</kbd><kbd>]</kbd> scale · <kbd>F</kbd> focus</small>
            </div>
            {!controller.zenThreadId && (
              <ConversationInstrument
                sources={instrumentSources}
                selectedThreadId={selectedThreadId}
                trailCount={controller.state.session.trails.length}
                onAction={handleInstrumentAction}
                onCreate={controller.createDraft}
                onClearTrails={controller.clearTrails}
              />
            )}
            {!controller.zenThreadId && controller.pendingPlacement && (
              <PlacementModeNotice
                placement={controller.pendingPlacement}
                onCancel={controller.cancelPlacement}
              />
            )}
            {!controller.zenThreadId && controller.removalUndo && (
              <PlacementUndoNotice
                removal={controller.removalUndo}
                onUndo={controller.undoRemoval}
                onDismiss={controller.dismissRemovalUndo}
              />
            )}
            {!controller.zenThreadId && !controller.pendingPlacement && (
              <OffscreenNodeMarker
                candidates={controller.offscreenCandidates}
                onAcknowledge={controller.acknowledgeOffscreenNodes}
                onLocate={controller.locateOffscreenNode}
              />
            )}
            {controller.zenConversation && (
              <ZenLayer
                conversation={controller.zenConversation}
                missions={controller.model.missions}
                savedScrollTop={controller.state.session.scrollTopByThreadId[controller.zenConversation.thread.id] ?? 0}
                actions={controller.actions}
                onExit={controller.exitZen}
              />
            )}
          </>
        )}
      />
    </div>
  );
}

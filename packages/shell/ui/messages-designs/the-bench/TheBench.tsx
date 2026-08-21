import { type EdgeTypes, type NodeTypes } from '@xyflow/react';
import { useEffect, useState, type KeyboardEvent } from 'react';
import './styles/tokens.css';
import './styles/canvas.css';
import './styles/primitives.css';
import { WorldCanvas } from '../../canvas/WorldCanvas';
import type { WorldCanvasInteraction } from '../../canvas/canvas-interaction';
import type { MessagesDesignProps } from '../contract';
import { LibraryPanel } from './library/LibraryPanel';
import { BENCH_VIEWPORT_KEY } from './model/bench-model';
import { useBenchController } from './model/useBenchController';
import { ConversationNode } from './nodes/ConversationNode';
import { ConversationFrameNode } from './nodes/ConversationFrameNode';
import { DraftConversationNode } from './nodes/DraftConversationNode';
import { InspectionWire } from './nodes/InspectionWire';
import { MessageInspectorNode } from './nodes/MessageInspectorNode';
import { RelatedObjectNode } from './nodes/RelatedObjectNode';
import { OffscreenNodeMarker } from './overlays/OffscreenNodeMarker';
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
  const controller = useBenchController(props);
  // ⌘K opens the Library's search; the panel owns all search state. The
  // listener is window-level so the shortcut works wherever focus sits.
  const [librarySearchSignal, setLibrarySearchSignal] = useState(0);
  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 'k') return;
      if (isTextInput(event.target)) return;
      event.preventDefault();
      setLibrarySearchSignal((signal) => signal + 1);
    };
    window.addEventListener('keydown', onWindowKeyDown);
    return () => window.removeEventListener('keydown', onWindowKeyDown);
  }, []);
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

  return (
    <div
      className="the-bench"
      data-bench-theme="night-instrument"
      data-zen-thread={controller.zenThreadId ?? 'none'}
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
        onSelect={controller.onCanvasSelect}
        resolveSelectionId={(node) => node.data.selectionId}
        onZoomChange={controller.onZoomChange}
        onViewportChange={controller.onViewportChange}
        dragGrid={{ xStep: 8, yStep: 8 }}
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
        canvasChildren={<div className="the-bench__field" aria-hidden="true" />}
        screenChildren={(
          <>
            <div className="the-bench__scale" aria-hidden="true">
              <span>Bench scale</span>
              <strong>{controller.state.zoomTier}</strong>
              <small><kbd>[</kbd><kbd>]</kbd> scale · <kbd>F</kbd> focus</small>
            </div>
            {!controller.zenThreadId && (
              <LibraryPanel
                conversations={controller.model.conversations}
                archivedThreads={props.data.threads.filter((thread) => thread.fields.archived === true)}
                shelvedThreadIds={controller.state.session.shelvedThreadIds}
                actions={controller.actions}
                onReveal={controller.revealConversation}
                onCreate={controller.createDraft}
                searchSignal={librarySearchSignal}
              />
            )}
            {!controller.zenThreadId && (
              <OffscreenNodeMarker
                candidates={controller.offscreenCandidates}
                onAcknowledge={controller.acknowledgeOffscreenNodes}
                onReveal={controller.revealOffscreenNode}
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

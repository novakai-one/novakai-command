import type {
  Edge,
  FitViewOptions,
  Node,
  ReactFlowInstance,
} from '@xyflow/react';
import type { CanvasNodeScreenBounds } from './canvas-runtime';
import { readRememberedViewport } from './canvas-memory';
import type {
  WorldCameraOutcome,
  WorldViewport,
  WorldViewportAnchor,
} from './world-camera';
import type { WorldCameraRuntime } from './world-camera-runtime';

type ReactFlowCanvasAdapterOptions<
  NodeType extends Node,
  EdgeType extends Edge,
> = {
  reactFlow: ReactFlowInstance<NodeType, EdgeType>;
  getCanvasElement(): HTMLElement | null;
};

type FrameNodesOptions = Parameters<WorldCameraRuntime['frameNodes']>[1];

type ReactFlowCanvasAdapter = {
  cameraRuntime: WorldCameraRuntime;
  getNodeScreenBounds(nodeId: string): CanvasNodeScreenBounds | null;
};

function animationDuration(requestedDuration?: number): number {
  if (typeof window === 'undefined') return requestedDuration ?? 480;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduceMotion ? 0 : (requestedDuration ?? 480);
}

function cameraOutcome(applied: boolean): WorldCameraOutcome {
  return applied ? 'applied' : 'not-ready';
}

function nodeExists<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  nodeId: string,
): boolean {
  return Boolean(options.reactFlow.getNode(nodeId));
}

async function frameNodes<NodeType extends Node, EdgeType extends Edge>(
  adapterOptions: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  nodeIds: readonly string[],
  cameraOptions: FrameNodesOptions,
): Promise<WorldCameraOutcome> {
  const allNodesExist = nodeIds.every((nodeId) => nodeExists(adapterOptions, nodeId));
  if (!allNodesExist) return 'node-missing';

  const applied = await adapterOptions.reactFlow.fitView({
    nodes: nodeIds.map((id) => ({ id })),
    padding: (cameraOptions.padding ?? 0.16) as FitViewOptions['padding'],
    minZoom: cameraOptions.minZoom ?? 0.28,
    maxZoom: cameraOptions.maxZoom ?? 0.96,
    duration: animationDuration(cameraOptions.duration),
  });

  return cameraOutcome(applied);
}

async function focusNodeAtAnchor<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  nodeId: string,
  anchor: WorldViewportAnchor,
  nodeAnchor?: WorldViewportAnchor,
  requestedZoom?: number,
  requestedDuration?: number,
): Promise<WorldCameraOutcome> {
  if (!nodeExists(options, nodeId)) return 'node-missing';

  const canvasElement = options.getCanvasElement();
  if (!canvasElement) return 'not-ready';

  const canvasBounds = canvasElement.getBoundingClientRect();
  if (canvasBounds.width === 0 || canvasBounds.height === 0) return 'not-ready';
  if (requestedZoom !== undefined && requestedZoom <= 0) return 'not-ready';

  const nodeBounds = options.reactFlow.getNodesBounds([nodeId]);
  const nodeTargetX = nodeBounds.x
    + nodeBounds.width * (nodeAnchor?.horizontalRatio ?? 0.5);
  const nodeTargetY = nodeBounds.y
    + nodeBounds.height * (nodeAnchor?.verticalRatio ?? 0.5);
  const zoom = requestedZoom ?? options.reactFlow.getViewport().zoom;

  const canvasCenterX = canvasBounds.left + canvasBounds.width / 2;
  const canvasCenterY = canvasBounds.top + canvasBounds.height / 2;
  const anchorX = canvasBounds.left + canvasBounds.width * anchor.horizontalRatio;
  const anchorY = canvasBounds.top + canvasBounds.height * anchor.verticalRatio;
  const flowCenterX = nodeTargetX - (anchorX - canvasCenterX) / zoom;
  const flowCenterY = nodeTargetY - (anchorY - canvasCenterY) / zoom;

  const applied = await options.reactFlow.setCenter(flowCenterX, flowCenterY, {
    zoom,
    duration: animationDuration(requestedDuration),
  });
  return cameraOutcome(applied);
}

async function setViewport<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  viewport: WorldViewport,
  requestedDuration?: number,
): Promise<WorldCameraOutcome> {
  const applied = await options.reactFlow.setViewport(viewport, {
    duration: animationDuration(requestedDuration),
  });
  return cameraOutcome(applied);
}

async function restoreViewport<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  memoryKey: string,
  requestedDuration?: number,
): Promise<WorldCameraOutcome> {
  const viewport = readRememberedViewport(memoryKey);
  if (!viewport) return 'viewport-missing';
  return setViewport(options, viewport, requestedDuration);
}

async function setZoom<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  zoom: number,
  requestedDuration?: number,
): Promise<WorldCameraOutcome> {
  if (zoom <= 0) return 'not-ready';

  const applied = await options.reactFlow.zoomTo(zoom, {
    duration: animationDuration(requestedDuration),
  });
  return cameraOutcome(applied);
}

function isOutsideCanvas(
  bounds: CanvasNodeScreenBounds,
  canvasBounds: DOMRect,
): boolean {
  return (
    bounds.right < canvasBounds.left
    || bounds.left > canvasBounds.right
    || bounds.bottom < canvasBounds.top
    || bounds.top > canvasBounds.bottom
  );
}

function getNodeScreenBounds<NodeType extends Node, EdgeType extends Edge>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
  nodeId: string,
): CanvasNodeScreenBounds | null {
  if (!nodeExists(options, nodeId)) return null;

  const canvasElement = options.getCanvasElement();
  if (!canvasElement) return null;

  const worldBounds = options.reactFlow.getNodesBounds([nodeId]);
  const topLeft = options.reactFlow.flowToScreenPosition({
    x: worldBounds.x,
    y: worldBounds.y,
  });
  const bottomRight = options.reactFlow.flowToScreenPosition({
    x: worldBounds.x + worldBounds.width,
    y: worldBounds.y + worldBounds.height,
  });
  const screenBounds: CanvasNodeScreenBounds = {
    top: topLeft.y,
    right: bottomRight.x,
    bottom: bottomRight.y,
    left: topLeft.x,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
    centerX: (topLeft.x + bottomRight.x) / 2,
    centerY: (topLeft.y + bottomRight.y) / 2,
  };

  return isOutsideCanvas(screenBounds, canvasElement.getBoundingClientRect())
    ? null
    : screenBounds;
}

/** Creates the only adapter allowed to translate public canvas behaviour into React Flow calls. */
export function createReactFlowCanvasAdapter<
  NodeType extends Node,
  EdgeType extends Edge,
>(
  options: ReactFlowCanvasAdapterOptions<NodeType, EdgeType>,
): ReactFlowCanvasAdapter {
  return {
    cameraRuntime: {
      frameNodes: (nodeIds, cameraOptions) => frameNodes(options, nodeIds, cameraOptions),
      focusNodeAtAnchor: (nodeId, anchor, nodeAnchor, zoom, duration) => (
        focusNodeAtAnchor(options, nodeId, anchor, nodeAnchor, zoom, duration)
      ),
      setViewport: (viewport, duration) => setViewport(options, viewport, duration),
      restoreViewport: (memoryKey, duration) => (
        restoreViewport(options, memoryKey, duration)
      ),
      setZoom: (zoom, duration) => setZoom(options, zoom, duration),
    },
    getNodeScreenBounds: (nodeId) => getNodeScreenBounds(options, nodeId),
  };
}

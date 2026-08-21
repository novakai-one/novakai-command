/** Framework-neutral controls exposed to disposable spatial room designs. */
export type WorldViewport = {
  x: number;
  y: number;
  zoom: number;
};

/** Compatibility request retained while the current Mission World moves to camera commands. */
export type CanvasCameraRequest = {
  key: string;
  nodeIds: readonly string[];
  padding?: WorldCameraPadding;
  viewportInsets?: WorldCameraPadding;
  maxZoom?: number;
  duration?: number;
};

export type WorldCameraPadding =
  | number
  | {
      top: number | string;
      right: number | string;
      bottom: number | string;
      left: number | string;
    };

/** A position inside the visible canvas, expressed as ratios from its top-left corner. */
export type WorldViewportAnchor = {
  horizontalRatio: number;
  verticalRatio: number;
};

type FrameNodesCameraCommand = {
  type: 'frame-nodes';
  key: string;
  nodeIds: readonly string[];
  padding?: WorldCameraPadding;
  minZoom?: number;
  maxZoom?: number;
  duration?: number;
};

type FocusNodeCameraCommand = {
  type: 'focus-node';
  key: string;
  nodeId: string;
  padding?: WorldCameraPadding;
  zoom?: number;
  duration?: number;
};

/** Places a node at a deliberate point in the viewport instead of always centring it. */
type FocusNodeAtAnchorCameraCommand = {
  type: 'focus-node-at-anchor';
  key: string;
  nodeId: string;
  anchor: WorldViewportAnchor;
  nodeAnchor?: WorldViewportAnchor;
  zoom?: number;
  duration?: number;
};

export type WorldCameraCommand =
  | FrameNodesCameraCommand
  | FocusNodeCameraCommand
  | FocusNodeAtAnchorCameraCommand
  | {
      type: 'set-viewport';
      key: string;
      viewport: WorldViewport;
      duration?: number;
    }
  | {
      type: 'restore-viewport';
      key: string;
      viewportKey?: string;
      duration?: number;
    }
  | {
      type: 'set-zoom';
      key: string;
      zoom: number;
      duration?: number;
    };

function canonicalCameraValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalCameraValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => [key, canonicalCameraValue(child)]));
}

/**
 * Identifies one active camera intent by its semantic key and complete payload.
 * Keys may recur after another command; an unchanged signature must not replay.
 */
export function worldCameraCommandSignature(command: WorldCameraCommand): string {
  const semanticCommand = command.type === 'frame-nodes'
    ? { ...command, nodeIds: [...new Set(command.nodeIds)].sort() }
    : command;
  return JSON.stringify(canonicalCameraValue(semanticCommand));
}

/** Translates the legacy request shape at the shared-canvas boundary. */
export function cameraRequestToCommand(
  request: CanvasCameraRequest | null | undefined,
): WorldCameraCommand | null {
  if (!request) return null;

  return {
    type: 'frame-nodes',
    key: request.key,
    nodeIds: request.nodeIds,
    padding: request.viewportInsets ?? request.padding,
    maxZoom: request.maxZoom,
    duration: request.duration,
  };
}

/** Typed result returned after the canvas interprets a camera command. */
export type WorldCameraOutcome =
  | 'applied'
  | 'node-missing'
  | 'viewport-missing'
  | 'no-nodes'
  | 'not-ready';

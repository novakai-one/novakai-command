import type {
  WorldCameraCommand,
  WorldCameraOutcome,
  WorldCameraPadding,
  WorldViewportAnchor,
  WorldViewport,
} from './world-camera';

type FrameNodesOptions = {
  padding?: WorldCameraPadding;
  minZoom?: number;
  maxZoom?: number;
  duration?: number;
};

export type WorldCameraRuntime = {
  frameNodes(
    nodeIds: readonly string[],
    options: FrameNodesOptions,
  ): Promise<WorldCameraOutcome>;
  focusNodeAtAnchor(
    nodeId: string,
    anchor: WorldViewportAnchor,
    nodeAnchor?: WorldViewportAnchor,
    zoom?: number,
    duration?: number,
  ): Promise<WorldCameraOutcome>;
  setViewport(
    viewport: WorldViewport,
    duration?: number,
  ): Promise<WorldCameraOutcome>;
  restoreViewport(
    viewportKey: string,
    duration?: number,
  ): Promise<WorldCameraOutcome>;
  setZoom(zoom: number, duration?: number): Promise<WorldCameraOutcome>;
};

/** Keeps camera command interpretation out of room designs and the React component. */
export function executeWorldCameraCommand(
  command: WorldCameraCommand,
  runtime: WorldCameraRuntime,
): Promise<WorldCameraOutcome> {
  switch (command.type) {
    case 'frame-nodes':
      if (command.nodeIds.length === 0) return Promise.resolve('no-nodes');
      return runtime.frameNodes(command.nodeIds, command);
    case 'focus-node':
      return runtime.frameNodes([command.nodeId], {
        padding: command.padding ?? 0.28,
        minZoom: command.zoom,
        maxZoom: command.zoom,
        duration: command.duration,
      });
    case 'focus-node-at-anchor':
      return runtime.focusNodeAtAnchor(
        command.nodeId,
        command.anchor,
        command.nodeAnchor,
        command.zoom,
        command.duration,
      );
    case 'set-viewport':
      return runtime.setViewport(command.viewport, command.duration);
    case 'restore-viewport':
      return runtime.restoreViewport(command.viewportKey ?? command.key, command.duration);
    case 'set-zoom':
      return runtime.setZoom(command.zoom, command.duration);
  }
}

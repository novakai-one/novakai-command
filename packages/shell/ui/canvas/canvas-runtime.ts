import type {
  WorldCameraCommand,
  WorldCameraOutcome,
  WorldViewport,
} from './world-camera';

/** Browser-viewport bounds for anchoring design-owned inspectors and tethers. */
export type CanvasNodeScreenBounds = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

/** The canvas behaviour exposed to a disposable spatial Room design. */
export type CanvasRuntime = {
  readonly viewport: WorldViewport;
  executeCameraCommand(command: WorldCameraCommand): Promise<WorldCameraOutcome>;
  getNodeScreenBounds(nodeId: string): CanvasNodeScreenBounds | null;
};

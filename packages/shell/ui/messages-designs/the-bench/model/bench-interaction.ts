import type { WorldCameraCommand } from '../../../canvas/world-camera';
import type { BenchAction, BenchZoomTier } from './bench-model';

const FAR_ZOOM_LIMIT = 0.5;
const NEAR_ZOOM_LIMIT = 1;
const KEYBOARD_ZOOM_STEP = 0.12;

/** Framework-neutral keyboard input interpreted by Bench policy. */
export type BenchKeyInput = {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly currentZoom: number;
  readonly activeThreadId: string | null;
};

/** Typed result of interpreting one Bench keyboard gesture. */
export type BenchKeyResult = {
  readonly action?: BenchAction;
  readonly cameraCommand?: WorldCameraCommand;
};

/** Resolves semantic detail without coupling cards to React Flow zoom events. */
export function resolveBenchZoomTier(zoom: number): BenchZoomTier {
  if (zoom < FAR_ZOOM_LIMIT) return 'far';
  if (zoom <= NEAR_ZOOM_LIMIT) return 'mid';
  return 'near';
}

/** Builds the explicit focus command used when Chris requests focus. */
export function buildFocusConversationCommand(threadId: string): WorldCameraCommand {
  return {
    type: 'focus-node',
    key: `bench:focus:${threadId}`,
    nodeId: threadId,
    padding: { top: '8%', right: '12%', bottom: '8%', left: '12%' },
    zoom: 1.08,
    duration: 260,
  };
}

/** Builds the explicit reveal command used by dock, search and offscreen controls. */
export function buildRevealNodeCommand(nodeId: string): WorldCameraCommand {
  return {
    type: 'focus-node-at-anchor',
    key: `bench:reveal:${nodeId}:${Date.now()}`,
    nodeId,
    anchor: { horizontalRatio: 0.5, verticalRatio: 0.5 },
    zoom: 0.88,
    duration: 360,
  };
}

/** Conversation-specific alias retained for design callers. */
export function buildRevealConversationCommand(threadId: string): WorldCameraCommand {
  return buildRevealNodeCommand(threadId);
}

/** Builds the command that restores the remembered Bench viewport. */
export function buildRestoreViewportCommand(): WorldCameraCommand {
  return {
    type: 'restore-viewport',
    key: 'bench:restore',
    viewportKey: 'messages:the-bench',
    duration: 260,
  };
}

/** Translates a supported keyboard gesture into semantic or camera intent. */
export function interpretBenchKey(input: BenchKeyInput): BenchKeyResult {
  if (input.key === '[' || input.key === ']') {
    const direction = input.key === '[' ? -1 : 1;
    return {
      cameraCommand: {
        type: 'set-zoom',
        key: `bench:zoom:${input.key}:${input.currentZoom}`,
        zoom: Math.max(0.25, Math.min(1.5, input.currentZoom + direction * KEYBOARD_ZOOM_STEP)),
        duration: 120,
      },
    };
  }
  return {};
}

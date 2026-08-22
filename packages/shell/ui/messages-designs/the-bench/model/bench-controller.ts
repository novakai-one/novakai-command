import type {
  CanvasPlacementChange,
  CanvasPlacementCommand,
  CanvasPlacementCommandOutcome,
  WorldPoint,
} from '../../../canvas/WorldCanvas';
import type { WorldCameraCommand, WorldViewport } from '../../../canvas/world-camera';
import type { ObjectId } from '../../contract';
import type { ConversationInstrumentAction } from '../conversation-instrument/contract';
import type { BenchKeyInput } from './bench-interaction';
import type {
  BenchConversation,
  BenchModel,
  BenchNodeActions,
  BenchOffscreenCandidate,
  BenchState,
} from './bench-model';
import type { BenchCanvasProjection } from './bench-projection';
import type { BenchPendingPlacement, BenchRemovalUndo } from './use-bench-placement-interaction';

/** Complete view-facing interface returned by the Bench orchestrator. */
export type BenchController = {
  readonly state: BenchState;
  readonly model: BenchModel;
  readonly conversationCatalog: readonly BenchConversation[];
  readonly removableThreadIds: readonly ObjectId[];
  readonly projection: BenchCanvasProjection;
  readonly selectedId: ObjectId | null;
  readonly cameraCommand: WorldCameraCommand | null;
  readonly placementCommand: CanvasPlacementCommand | null;
  readonly pendingPlacement: BenchPendingPlacement | null;
  readonly removalUndo: BenchRemovalUndo | null;
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
  readonly onPaneClick: (position: WorldPoint) => void;
  readonly onPanePointerMove: (position: WorldPoint) => void;
  readonly onKeyInput: (input: Omit<BenchKeyInput, 'currentZoom'>) => void;
  readonly createDraft: () => void;
  readonly clearTrails: () => void;
  readonly actOnConversation: (action: ConversationInstrumentAction) => void;
  readonly cancelPlacement: () => void;
  readonly undoRemoval: () => void;
  readonly dismissRemovalUndo: () => void;
  readonly locateOffscreenNode: (nodeId: string) => void;
  readonly acknowledgeOffscreenNodes: (nodeIds: readonly string[]) => void;
  readonly exitZen: () => void;
};

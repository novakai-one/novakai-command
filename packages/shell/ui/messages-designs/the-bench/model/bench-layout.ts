import type { CanvasNodePlacement, WorldPoint } from '../../../canvas/WorldCanvas';
import type { BenchInspectionTrail, BenchModel, BenchState } from './bench-model';

/** Fixed card geometry required by the Bench contract. */
export const BENCH_CARD_SIZE = { width: 320, height: 128 } as const;

/** Fixed open-thread geometry required by the Bench contract. */
export const BENCH_THREAD_SIZE = { width: 420, height: 640 } as const;

/** Fixed inspection-node geometry used by rightward trail layout. */
export const BENCH_INSPECTOR_SIZE = { width: 280, height: 320 } as const;

/** Fixed generic related-object geometry used by every inspected kind. */
export const BENCH_RELATED_OBJECT_SIZE = { width: 300, height: 392 } as const;

/** Fixed semantic-frame geometry; children retain their absolute world positions. */
export const BENCH_FRAME_SIZE = { width: 760, height: 720 } as const;

/** Header area reserved for naming and moving a frame. */
export const BENCH_FRAME_HEADER_HEIGHT = 48;

/** Framework-neutral placement consumed by Bench layout. */
export type BenchPlacement = CanvasNodePlacement;

/** Placement lookup used by projection without owning persistence. */
export type BenchPlacementMap = ReadonlyMap<string, BenchPlacement>;

/** Result of placing one inspection trail. */
export type BenchTrailLayout = ReadonlyMap<string, WorldPoint>;

const DEFAULT_CONVERSATION_POINTS: readonly WorldPoint[] = [
  { x: 80, y: 72 },
  { x: 456, y: 104 },
  { x: 832, y: 56 },
  { x: 160, y: 312 },
  { x: 552, y: 352 },
  { x: 936, y: 296 },
  { x: 304, y: 560 },
  { x: 760, y: 584 },
  { x: 1136, y: 544 },
  { x: 72, y: 824 },
];

const INSPECTION_GAP_X = 88;
const INSPECTION_STEP_Y = 48;
const INSPECTION_ROW_STEP = BENCH_RELATED_OBJECT_SIZE.height + INSPECTION_STEP_Y;

/** Snaps a world point to the configured drag grid. */
export function snapBenchPoint(point: WorldPoint, step = 8): WorldPoint {
  return {
    x: Math.round(point.x / step) * step,
    y: Math.round(point.y / step) * step,
  };
}

/** Converts a placement snapshot into a read-only lookup. */
export function placementMapOf(placements: readonly BenchPlacement[]): BenchPlacementMap {
  return new Map(placements.map((placement) => [placement.id, placement]));
}

/** Returns a restored conversation position or its deliberate first-visit point. */
export function conversationPoint(
  nodeId: string,
  conversationIndex: number,
  placements: BenchPlacementMap,
): WorldPoint {
  const restored = placements.get(nodeId);
  if (restored) return { ...restored.position };
  const point = DEFAULT_CONVERSATION_POINTS[conversationIndex % DEFAULT_CONVERSATION_POINTS.length];
  const row = Math.floor(conversationIndex / DEFAULT_CONVERSATION_POINTS.length);
  return { x: point.x + row * 64, y: point.y + row * 760 };
}

function layoutLanes(trail: BenchInspectionTrail): ReadonlyMap<string, number> {
  const lanes = new Map<string, number>();
  const children = new Map<string, BenchInspectionTrail['steps'][number][]>();
  for (const step of trail.steps) {
    if (!step.parentStepId) continue;
    const siblings = children.get(step.parentStepId) ?? [];
    siblings.push(step);
    children.set(step.parentStepId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => (
      left.siblingOrder - right.siblingOrder || left.id.localeCompare(right.id)
    ));
  }

  const root = trail.steps.find((step) => step.parentStepId === null);
  if (!root) return lanes;
  lanes.set(root.id, 0);
  let nextUnusedLane = 1;
  const placeChildren = (parentId: string): void => {
    const parentLane = lanes.get(parentId) ?? 0;
    (children.get(parentId) ?? []).forEach((child, index) => {
      const lane = index === 0 ? parentLane : nextUnusedLane++;
      lanes.set(child.id, lane);
      placeChildren(child.id);
    });
  };
  placeChildren(root.id);
  return lanes;
}

/** Places an inspection trail to the right of its restored conversation parent. */
export function layoutInspectionTrail(
  trail: BenchInspectionTrail,
  state: BenchState,
  conversationPosition: WorldPoint,
  trailIndex: number,
  placements: BenchPlacementMap,
): BenchTrailLayout {
  const conversationWidth = state.session.openThreadIds.includes(trail.threadId)
    ? BENCH_THREAD_SIZE.width
    : BENCH_CARD_SIZE.width;
  const relationX = conversationPosition.x + conversationWidth + INSPECTION_GAP_X;
  const relationY = conversationPosition.y + 64 + trailIndex * INSPECTION_STEP_Y;
  const lanes = layoutLanes(trail);
  const stepsById = new Map(trail.steps.map((step) => [step.id, step]));
  const proposed = new Map<string, WorldPoint>();
  const resolved = new Map<string, WorldPoint>();

  for (const step of trail.steps) {
    if (!step.parentStepId) {
      const position = snapBenchPoint({ x: relationX, y: relationY });
      proposed.set(step.id, position);
      resolved.set(step.id, placements.get(step.id)?.position ?? position);
      continue;
    }

    const parent = stepsById.get(step.parentStepId);
    const parentPosition = resolved.get(step.parentStepId);
    if (!parent || !parentPosition) continue;
    const parentWidth = parent.kind === 'relations'
      ? BENCH_INSPECTOR_SIZE.width
      : BENCH_RELATED_OBJECT_SIZE.width;
    const parentLane = lanes.get(parent.id) ?? 0;
    const lane = lanes.get(step.id) ?? parentLane;
    const position = snapBenchPoint({
      x: parentPosition.x + parentWidth + INSPECTION_GAP_X,
      y: lane === parentLane ? parentPosition.y : relationY + lane * INSPECTION_ROW_STEP,
    });
    proposed.set(step.id, position);
    resolved.set(step.id, placements.get(step.id)?.position ?? position);
  }
  return proposed;
}

/** Finds an unoccupied point for later pane-created nodes. */
export function firstFreePoint(
  requested: WorldPoint,
  occupied: readonly WorldPoint[],
  visibleBounds?: { readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number },
): WorldPoint {
  const origin = snapBenchPoint(requested);
  const conflicts = (point: WorldPoint) => occupied.some((other) => (
    Math.abs(other.x - point.x) < BENCH_CARD_SIZE.width
    && Math.abs(other.y - point.y) < BENCH_CARD_SIZE.height
  ));
  if (!conflicts(origin)) return origin;

  if (visibleBounds) {
    const candidates: WorldPoint[] = [];
    for (let y = visibleBounds.minY; y <= visibleBounds.maxY; y += 40) {
      for (let x = visibleBounds.minX; x <= visibleBounds.maxX; x += 40) {
        candidates.push(snapBenchPoint({ x, y }));
      }
    }
    candidates.sort((left, right) => (
      Math.hypot(left.x - origin.x, left.y - origin.y)
      - Math.hypot(right.x - origin.x, right.y - origin.y)
    ));
    const visibleCandidate = candidates.find((candidate) => !conflicts(candidate));
    if (visibleCandidate) return visibleCandidate;
  }

  const stepX = BENCH_CARD_SIZE.width + 40;
  const stepY = BENCH_CARD_SIZE.height + 40;
  for (let radius = 1; radius <= 8; radius += 1) {
    const offsets = [
      { x: 0, y: radius },
      { x: radius, y: 0 },
      { x: -radius, y: 0 },
      { x: 0, y: -radius },
      { x: radius, y: radius },
      { x: -radius, y: radius },
      { x: radius, y: -radius },
      { x: -radius, y: -radius },
    ];
    for (const offset of offsets) {
      const candidate = { x: origin.x + offset.x * stepX, y: origin.y + offset.y * stepY };
      if (!conflicts(candidate)) return candidate;
    }
  }
  return { x: origin.x + stepX * 9, y: origin.y };
}

/** Returns the frame position produced by dropping one conversation near another. */
export function frameDropPoint(first: WorldPoint, second: WorldPoint): WorldPoint {
  return snapBenchPoint({
    x: Math.min(first.x, second.x) - 24,
    y: Math.min(first.y, second.y) - 40,
  });
}

type WorldRect = WorldPoint & { readonly width: number; readonly height: number };

/** Deterministic semantic result of one committed conversation drag. */
export type BenchFrameDropIntent =
  | { readonly type: 'none' }
  | { readonly type: 'join'; readonly threadId: string; readonly frameId: string }
  | { readonly type: 'release'; readonly threadId: string }
  | {
      readonly type: 'create';
      readonly threadId: string;
      readonly targetThreadId: string;
      readonly position: WorldPoint;
    };

function conversationRect(
  threadId: string,
  placement: BenchPlacement,
  state: BenchState,
): WorldRect {
  const size = state.session.openThreadIds.includes(threadId) ? BENCH_THREAD_SIZE : BENCH_CARD_SIZE;
  return { ...placement.position, ...size };
}

function overlapRatio(first: WorldRect, second: WorldRect): number {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  const smallerArea = Math.min(first.width * first.height, second.width * second.height);
  return smallerArea === 0 ? 0 : (width * height) / smallerArea;
}

function frameForThread(state: BenchState, threadId: string): string | null {
  return state.session.frames.find((frame) => frame.conversationIds.includes(threadId))?.id ?? null;
}

function frameInteriorContains(frame: BenchPlacement, point: WorldPoint): boolean {
  return point.x >= frame.position.x
    && point.x <= frame.position.x + BENCH_FRAME_SIZE.width
    && point.y >= frame.position.y + BENCH_FRAME_HEADER_HEIGHT
    && point.y <= frame.position.y + BENCH_FRAME_SIZE.height;
}

/** Applies the frozen 40% frame rule to one complete absolute placement snapshot. */
export function resolveBenchFrameDrop(
  movedNodeId: string,
  placements: readonly BenchPlacement[],
  model: BenchModel,
  state: BenchState,
): BenchFrameDropIntent {
  if (!model.conversationsById.has(movedNodeId)) return { type: 'none' };
  const placementMap = placementMapOf(placements);
  const movedPlacement = placementMap.get(movedNodeId);
  if (!movedPlacement) return { type: 'none' };
  const movedRect = conversationRect(movedNodeId, movedPlacement, state);
  const center = {
    x: movedRect.x + movedRect.width / 2,
    y: movedRect.y + movedRect.height / 2,
  };
  const currentFrameId = frameForThread(state, movedNodeId);

  const containingFrames = state.session.frames
    .map((frame) => ({ frame, placement: placementMap.get(frame.id) }))
    .filter((entry): entry is { frame: typeof entry.frame; placement: BenchPlacement } => (
      Boolean(entry.placement && frameInteriorContains(entry.placement, center))
    ))
    .sort((left, right) => left.frame.id.localeCompare(right.frame.id));
  const destinationFrame = containingFrames[0]?.frame;
  if (destinationFrame) {
    return destinationFrame.id === currentFrameId
      ? { type: 'none' }
      : { type: 'join', threadId: movedNodeId, frameId: destinationFrame.id };
  }

  if (currentFrameId) return { type: 'release', threadId: movedNodeId };

  const qualifying = model.conversations
    .filter((conversation) => conversation.thread.id !== movedNodeId)
    .map((conversation) => {
      const placement = placementMap.get(conversation.thread.id);
      if (!placement) return null;
      return {
        threadId: conversation.thread.id,
        frameId: frameForThread(state, conversation.thread.id),
        placement,
        overlap: overlapRatio(movedRect, conversationRect(conversation.thread.id, placement, state)),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry && entry.overlap >= 0.4))
    .sort((left, right) => right.overlap - left.overlap || left.threadId.localeCompare(right.threadId));

  const target = qualifying[0];
  if (!target) return { type: 'none' };
  if (target.frameId) return { type: 'join', threadId: movedNodeId, frameId: target.frameId };
  return {
    type: 'create',
    threadId: movedNodeId,
    targetThreadId: target.threadId,
    position: frameDropPoint(movedRect, target.placement.position),
  };
}

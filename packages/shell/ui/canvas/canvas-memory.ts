import type { Node } from '@xyflow/react';
import type {
  CanvasNodePlacement,
  CanvasPlacementCommand,
  CanvasPlacementCommandOutcome,
  WorldPoint,
} from './canvas-placement';
import type { WorldViewport } from './world-camera';

type StoredCanvasPlacement = {
  readonly position: WorldPoint;
  readonly parentId?: string;
};

const CANVAS_MEMORY_STORAGE_KEY = 'novakai:world-canvas:v1';

type StoredCanvasMemory = {
  viewports: Record<string, WorldViewport>;
  placements: Record<string, Record<string, StoredCanvasPlacement>>;
};

type LegacyStoredCanvasMemory = {
  viewports?: Record<string, unknown>;
  positions?: Record<string, Record<string, unknown>>;
  placements?: Record<string, Record<string, unknown>>;
};

const rememberedViewports = new Map<string, WorldViewport>();
const rememberedNodePlacements = new Map<string, Map<string, StoredCanvasPlacement>>();
let hasLoadedBrowserMemory = false;
let browserMemoryAvailable = true;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWorldPoint(value: unknown): value is WorldPoint {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<WorldPoint>;
  return isFiniteNumber(position.x) && isFiniteNumber(position.y);
}

function isWorldViewport(value: unknown): value is WorldViewport {
  if (!isWorldPoint(value)) return false;
  return isFiniteNumber((value as Partial<WorldViewport>).zoom);
}

function parseStoredPlacement(value: unknown): StoredCanvasPlacement | null {
  if (isWorldPoint(value)) return { position: { ...value } };
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredCanvasPlacement>;
  if (!isWorldPoint(candidate.position)) return null;
  if (candidate.parentId !== undefined && typeof candidate.parentId !== 'string') return null;
  return {
    position: { ...candidate.position },
    ...(candidate.parentId ? { parentId: candidate.parentId } : {}),
  };
}

function loadBrowserMemory(): void {
  if (hasLoadedBrowserMemory || typeof window === 'undefined') return;
  hasLoadedBrowserMemory = true;

  try {
    const stored = window.localStorage.getItem(CANVAS_MEMORY_STORAGE_KEY);
    if (!stored) return;
    const parsed = JSON.parse(stored) as LegacyStoredCanvasMemory;
    for (const [key, viewport] of Object.entries(parsed.viewports ?? {})) {
      if (isWorldViewport(viewport)) rememberedViewports.set(key, { ...viewport });
    }
    const placementStores = parsed.placements ?? parsed.positions ?? {};
    for (const [key, placements] of Object.entries(placementStores)) {
      const validPlacements = Object.entries(placements)
        .map(([id, value]) => [id, parseStoredPlacement(value)] as const)
        .filter((entry): entry is readonly [string, StoredCanvasPlacement] => entry[1] !== null);
      rememberedNodePlacements.set(key, new Map(validPlacements));
    }
  } catch {
    browserMemoryAvailable = false;
    try {
      window.localStorage.removeItem(CANVAS_MEMORY_STORAGE_KEY);
    } catch {
      // The in-memory maps remain the same-runtime fallback for the shared canvas.
    }
  }
}

function storeBrowserMemory(): void {
  if (typeof window === 'undefined' || !browserMemoryAvailable) return;

  const viewports = Object.fromEntries(
    [...rememberedViewports].map(([key, viewport]) => [key, { ...viewport }]),
  );
  const placements = Object.fromEntries(
    [...rememberedNodePlacements].map(([key, values]) => [
      key,
      Object.fromEntries([...values].map(([id, placement]) => [id, {
        position: { ...placement.position },
        ...(placement.parentId ? { parentId: placement.parentId } : {}),
      }])),
    ]),
  );

  try {
    window.localStorage.setItem(
      CANVAS_MEMORY_STORAGE_KEY,
      JSON.stringify({ viewports, placements } satisfies StoredCanvasMemory),
    );
  } catch {
    browserMemoryAvailable = false;
  }
}

function placementMap(memoryKey: string): Map<string, StoredCanvasPlacement> {
  loadBrowserMemory();
  const placements = rememberedNodePlacements.get(memoryKey) ?? new Map();
  rememberedNodePlacements.set(memoryKey, placements);
  return placements;
}

function copyPlacement(placement: StoredCanvasPlacement): StoredCanvasPlacement {
  return {
    position: { ...placement.position },
    ...(placement.parentId ? { parentId: placement.parentId } : {}),
  };
}

/** Reads a defensive copy of the viewport remembered for a Room design. */
export function readRememberedViewport(memoryKey: string): WorldViewport | undefined {
  loadBrowserMemory();
  const viewport = rememberedViewports.get(memoryKey);
  return viewport ? { ...viewport } : undefined;
}

/** Remembers the latest settled viewport for a Room design. */
export function rememberViewport(memoryKey: string, viewport: WorldViewport): void {
  loadBrowserMemory();
  rememberedViewports.set(memoryKey, { ...viewport });
  storeBrowserMemory();
}

/**
 * Restores absolute placements and privately converts semantic parent projection to
 * React Flow-relative child coordinates. Incoming node positions are world-space.
 */
export function restoreNodePlacements<NodeType extends Node>(
  memoryKey: string,
  nodes: readonly NodeType[],
): NodeType[] {
  const stored = placementMap(memoryKey);
  const nodeIds = new Set(nodes.map((node) => node.id));
  let memoryChanged = false;

  const absoluteById = new Map<string, WorldPoint>();
  for (const node of nodes) {
    const remembered = stored.get(node.id);
    const absolute = remembered?.position ?? node.position;
    absoluteById.set(node.id, { ...absolute });
  }

  for (const node of nodes) {
    const desiredParentId = node.parentId && nodeIds.has(node.parentId)
      ? node.parentId
      : undefined;
    const remembered = stored.get(node.id);
    const absolute = absoluteById.get(node.id) ?? node.position;
    if (
      !remembered
      || remembered.parentId !== desiredParentId
      || remembered.position.x !== absolute.x
      || remembered.position.y !== absolute.y
    ) {
      stored.set(node.id, {
        position: { ...absolute },
        ...(desiredParentId ? { parentId: desiredParentId } : {}),
      });
      memoryChanged = true;
    }
  }

  if (memoryChanged) storeBrowserMemory();

  return nodes.map((node) => {
    const absolute = absoluteById.get(node.id) ?? node.position;
    const desiredParentId = node.parentId && nodeIds.has(node.parentId)
      ? node.parentId
      : undefined;
    if (!desiredParentId) {
      return { ...node, position: { ...absolute }, parentId: undefined };
    }
    const parentAbsolute = absoluteById.get(desiredParentId);
    if (!parentAbsolute) {
      return { ...node, position: { ...absolute }, parentId: undefined };
    }
    return {
      ...node,
      parentId: desiredParentId,
      position: {
        x: absolute.x - parentAbsolute.x,
        y: absolute.y - parentAbsolute.y,
      },
    };
  });
}

/** Remembers a complete settled absolute placement snapshot. */
export function rememberNodePlacements(
  memoryKey: string,
  placements: readonly CanvasNodePlacement[],
): void {
  const stored = placementMap(memoryKey);
  for (const placement of placements) {
    stored.set(placement.id, {
      position: { ...placement.position },
      ...(placement.parentId ? { parentId: placement.parentId } : {}),
    });
  }
  storeBrowserMemory();
}

/** Seeds only genuinely new projected nodes before an identity/parent command executes. */
export function rememberInitialNodePlacements<NodeType extends Node>(
  memoryKey: string,
  nodes: readonly NodeType[],
): void {
  const stored = placementMap(memoryKey);
  const nodeIds = new Set(nodes.map((node) => node.id));
  let changed = false;
  for (const node of nodes) {
    if (stored.has(node.id)) continue;
    const parentId = node.parentId && nodeIds.has(node.parentId) ? node.parentId : undefined;
    stored.set(node.id, {
      position: { x: node.position.x, y: node.position.y },
      ...(parentId ? { parentId } : {}),
    });
    changed = true;
  }
  if (changed) storeBrowserMemory();
}

function rejected(
  key: string,
  reason: Extract<CanvasPlacementCommandOutcome, { status: 'rejected' }>['reason'],
): CanvasPlacementCommandOutcome {
  return { key, status: 'rejected', reason };
}

/** Applies one all-or-nothing identity/parent command to remembered placement. */
export function applyCanvasPlacementCommand(
  memoryKey: string,
  command: CanvasPlacementCommand,
): CanvasPlacementCommandOutcome {
  if (command.type !== 'apply-placement-mutations' || command.mutations.length === 0) {
    return rejected(command.key, 'invalid-command');
  }

  const current = placementMap(memoryKey);
  const next = new Map([...current].map(([id, placement]) => [id, copyPlacement(placement)]));

  for (const mutation of command.mutations) {
    if (mutation.type === 'replace-node-identity') {
      if (!mutation.fromNodeId || !mutation.toNodeId || mutation.fromNodeId === mutation.toNodeId) {
        return rejected(command.key, 'invalid-command');
      }
      const source = next.get(mutation.fromNodeId);
      if (!source) return rejected(command.key, 'node-missing');
      if (next.has(mutation.toNodeId)) return rejected(command.key, 'duplicate-target');
      next.delete(mutation.fromNodeId);
      next.set(mutation.toNodeId, source);
      for (const [id, placement] of next) {
        if (placement.parentId === mutation.fromNodeId) {
          next.set(id, { ...placement, parentId: mutation.toNodeId });
        }
      }
      continue;
    }

    const node = next.get(mutation.nodeId);
    if (!node) return rejected(command.key, 'node-missing');
    if (mutation.parentId === mutation.nodeId) return rejected(command.key, 'invalid-command');
    if (mutation.parentId && !next.has(mutation.parentId)) {
      return rejected(command.key, 'parent-missing');
    }
    next.set(mutation.nodeId, {
      position: { ...node.position },
      ...(mutation.parentId ? { parentId: mutation.parentId } : {}),
    });
  }

  rememberedNodePlacements.set(memoryKey, next);
  storeBrowserMemory();
  return { key: command.key, status: 'applied' };
}
